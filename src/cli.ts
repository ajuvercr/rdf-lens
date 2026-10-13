import { Quad, Term } from "@rdfjs/types";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Parser } from "n3";
import { checkShapes, Finding } from "./check";

// Node 18 and later have fetch, the @types/node this builds with does not
// declare it
declare const fetch: (
    url: string,
    init: { headers: { [name: string]: string } },
) => Promise<{
    ok: boolean;
    status: number;
    statusText: string;
    headers: { get(name: string): string | null };
    text(): Promise<string>;
}>;

const OWL_IMPORTS = "http://www.w3.org/2002/07/owl#imports";

const USAGE = `Usage: rdf-lens check [--no-imports] <file or url>...

Reads the SHACL shapes in the given Turtle or TriG files, and the files they
import with owl:imports, and extracts every node typed with a target class of
one of the shapes. Prints the deprecated constructs rdf-lens warns about and
what fails to extract.

Pass example data, like a pipeline using your processor, next to the shapes
to also check what that data hands them: some warnings, such as sh:datatype
xsd:string given an IRI, depend on it.

  --no-imports  do not follow owl:imports

Exits with 1 when it finds something, 2 when it cannot run.`;

/**
 * Loaded holds the quads read from the given locations and the files they
 * import, and what could not be read.
 */
export type Loaded = { quads: Quad[]; problems: string[] };

/**
 * loadQuads reads Turtle or TriG from files and URLs, following owl:imports
 * unless imports is false. Relative paths resolve against the working
 * directory.
 */
export async function loadQuads(
    locations: string[],
    imports = true,
): Promise<Loaded> {
    const todo = locations.map(toUrl);
    const done = new Set<string>();
    const quads: Quad[] = [];
    const problems: string[] = [];

    for (let url = todo.shift(); url; url = todo.shift()) {
        // A fragment names something in a document, not another document
        const document = url.split("#")[0];
        if (done.has(document)) continue;
        done.add(document);

        let found: Quad[];
        try {
            found = new Parser({ baseIRI: document }).parse(
                await fetchText(document),
            );
        } catch (ex) {
            const message = ex instanceof Error ? ex.message : String(ex);
            problems.push(`Cannot read ${document}: ${message}`);
            continue;
        }

        quads.push(...found);
        if (imports) {
            todo.push(
                ...found
                    .filter(
                        (q) =>
                            q.predicate.value === OWL_IMPORTS &&
                            q.object.termType === "NamedNode",
                    )
                    .map((q) => q.object.value),
            );
        }
    }

    return { quads, problems };
}

/**
 * main runs the command line with the given arguments, printing with print,
 * and returns the exit code.
 */
export async function main(
    args: string[],
    print: (line: string) => void = console.log,
): Promise<number> {
    const [command, ...rest] = args;
    if (command === "--help" || command === "-h" || command === "help") {
        print(USAGE);
        return 0;
    }
    if (command !== "check") {
        print(USAGE);
        return 2;
    }

    const unknown = rest.filter(
        (x) => x.startsWith("--") && x !== "--no-imports",
    );
    const locations = rest.filter((x) => !x.startsWith("--"));
    if (unknown.length > 0 || locations.length === 0) {
        if (unknown.length > 0) print(`Unknown option ${unknown.join(", ")}`);
        print(USAGE);
        return 2;
    }

    const { quads, problems } = await loadQuads(
        locations,
        !rest.includes("--no-imports"),
    );
    for (const problem of problems) print(`error    ${problem}`);
    if (quads.length === 0) return 2;

    const report = checkShapes(quads);
    for (const finding of report.findings) print(formatFinding(finding));

    const count = (level: Finding["level"]) =>
        report.findings.filter((x) => x.level === level).length +
        (level === "error" ? problems.length : 0);
    const errors = count("error");
    const warnings = count("warning");
    print(
        `${report.findings.length > 0 || problems.length > 0 ? "\n" : ""}` +
            `Checked ${plural(report.shapes, "shape")} on ` +
            `${plural(report.focusNodes, "node")}: ` +
            `${plural(warnings, "warning")}, ${plural(errors, "error")}.`,
    );
    if (report.unchecked.length > 0) {
        print(
            "Not checked, no shape describes them: " +
                report.unchecked.map(termToString).join(", "),
        );
    }

    return errors + warnings > 0 ? 1 : 0;
}

function formatFinding(finding: Finding): string {
    const message = finding.message.replace(/^rdf-lens: /, "");
    const level = finding.level.padEnd(8);
    if (finding.level === "error" && finding.focus) {
        return `${level} ${termToString(finding.focus)}: ${message}`;
    }
    if (finding.focus) {
        return `${level} ${message}\n         seen on ${termToString(finding.focus)}`;
    }
    return `${level} ${message}`;
}

async function fetchText(url: string): Promise<string> {
    if (url.startsWith("file:")) {
        return readFile(fileURLToPath(url), "utf8");
    }
    const response = await fetch(url, {
        headers: {
            accept: "text/turtle, application/trig;q=0.9, application/n-triples;q=0.8, application/n-quads;q=0.8",
        },
    });
    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
    }
    const type = response.headers.get("content-type") ?? "";
    if (type.includes("json")) {
        throw new Error(`${type} is not supported, only Turtle and TriG`);
    }
    return response.text();
}

function toUrl(location: string): string {
    if (
        /^[a-z][a-z0-9+.-]+:/i.test(location) &&
        !/^[a-z]:[\\/]/i.test(location)
    ) {
        return location;
    }
    return pathToFileURL(resolve(location)).href;
}

function plural(count: number, word: string): string {
    return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function termToString(term: Term): string {
    if (term.termType === "NamedNode") return "<" + term.value + ">";
    if (term.termType === "BlankNode") return "_:" + term.value;
    return JSON.stringify(term.value);
}

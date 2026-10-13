import { describe, expect, test } from "vitest";
import { fileURLToPath } from "node:url";
import { loadQuads, main } from "../src/cli";

const fixture = (name: string) =>
    fileURLToPath(new URL("./check/" + name, import.meta.url));

async function run(...args: string[]) {
    const lines: string[] = [];
    const code = await main(args, (line) => lines.push(line));
    return { code, output: lines.join("\n") };
}

describe("rdf-lens check", () => {
    test("checks a processor definition on its own", async () => {
        const { code, output } = await run("check", fixture("processor.ttl"));

        expect(code).toBe(1);
        expect(output).toContain(
            'warning  property "url" (path <http://example.org/url>, ' +
                "shape <http://example.org/Fetch>) uses sh:datatype xsd:iri, " +
                "which is deprecated: use sh:nodeKind sh:IRI when it holds IRIs",
        );
        expect(output).toContain(
            "Checked 1 shape on 0 nodes: 1 warning, 0 errors.",
        );
        expect(output).toContain(
            "Not checked, no shape describes them: <http://example.org/Writer>",
        );
    });

    test("checks the data in a pipeline and the shapes it imports", async () => {
        const { code, output } = await run("check", fixture("pipeline.ttl"));
        const base = new URL("./check/", import.meta.url).href;

        expect(code).toBe(1);
        expect(output).toContain(
            "uses sh:datatype xsd:iri, which is deprecated: use sh:nodeKind " +
                "sh:IRI instead, it extracts the same term.\n" +
                `         seen on <${base}fetch>`,
        );
        expect(output).toContain(
            `declares sh:datatype xsd:string but was given the IRI <${base}data.ttl>`,
        );
        expect(output).toContain(
            `error    <${base}broken>: Field is not defined and required, in field "url"`,
        );
        expect(output).toContain(
            "Checked 1 shape on 2 nodes: 2 warnings, 1 error.",
        );
    });

    test("--no-imports reads only the given files", async () => {
        const { quads } = await loadQuads([fixture("pipeline.ttl")], false);
        const { code, output } = await run(
            "check",
            "--no-imports",
            fixture("pipeline.ttl"),
        );

        expect(quads.some((q) => q.object.value.endsWith("Fetch"))).toBe(true);
        expect(code).toBe(0);
        expect(output).toBe(
            "Checked 0 shapes on 0 nodes: 0 warnings, 0 errors.",
        );
    });

    test("a file that cannot be read is an error", async () => {
        const { code, output } = await run(
            "check",
            fixture("processor.ttl"),
            fixture("missing.ttl"),
        );

        expect(code).toBe(1);
        expect(output).toContain(
            `error    Cannot read file://${fixture("missing.ttl")}`,
        );
        expect(output).toContain("1 warning, 1 error.");
    });

    test("without files it prints how to use it", async () => {
        expect(await run("check")).toMatchObject({
            code: 2,
            output: expect.stringContaining("Usage: rdf-lens check"),
        });
        expect(await run("nonsense")).toMatchObject({ code: 2 });
        expect(await run("--help")).toMatchObject({ code: 0 });
    });
});

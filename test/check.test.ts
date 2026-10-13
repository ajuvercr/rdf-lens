import { describe, expect, test } from "vitest";
import { Parser } from "n3";
import { checkShapes, Finding } from "../src/check";
import { setWarningHandler } from "../src/shacl";

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/> .
`;

const check = (turtle: string) =>
    checkShapes(new Parser().parse(prefixes + turtle));

// A shape for ex:Thing with a property v0, v1, ... for each constraint
function shapeWith(...constraints: string[]): string {
    const properties = constraints.map(
        (constraint, i) =>
            `[ sh:name "v${i}"; sh:path ex:v${i}; sh:maxCount 1; ${constraint} ]`,
    );
    return `[] a sh:NodeShape; sh:targetClass ex:Thing; sh:property ${properties.join(", ")}.`;
}

const summary = (findings: Finding[]) =>
    findings.map((x) => `${x.level}: ${x.message}`);

describe("checkShapes", () => {
    test("modern shapes and fitting data have no findings", () => {
        const report = check(
            shapeWith(
                "sh:datatype xsd:integer;",
                "sh:nodeKind sh:IRI;",
                "sh:nodeKind sh:IRIOrLiteral; sh:codeType xsd:string;",
            ) + "ex:a a ex:Thing; ex:v0 4; ex:v1 ex:b; ex:v2 <./c>.",
        );

        expect(report.findings).toEqual([]);
        expect(report.shapes).toBe(1);
        expect(report.focusNodes).toBe(1);
    });

    test("sh:datatype xsd:iri is found without data", () => {
        const report = check(shapeWith("sh:datatype xsd:iri;"));

        expect(summary(report.findings)).toEqual([
            'warning: rdf-lens: property "v0" (path <http://example.org/v0>, ' +
                "shape <http://example.org/Thing>) uses sh:datatype xsd:iri, " +
                "which is deprecated: use sh:nodeKind sh:IRI when it holds " +
                "IRIs, or sh:nodeKind sh:IRIOrLiteral and sh:codeType " +
                "xsd:anyURI when it also holds strings with an IRI.",
        ]);
    });

    test("data replaces the general advice for sh:datatype xsd:iri", () => {
        const report = check(
            shapeWith("sh:datatype xsd:iri;") + "ex:a a ex:Thing; ex:v0 ex:b.",
        );

        expect(report.findings).toHaveLength(1);
        expect(report.findings[0].message).toContain(
            "use sh:nodeKind sh:IRI instead, it extracts the same term",
        );
        expect(report.findings[0].focus?.value).toBe("http://example.org/a");
    });

    test("a shared property shape is advised about once", () => {
        const report = check(`
_:iri sh:name "iri"; sh:path ex:iri; sh:datatype xsd:iri.
[] a sh:NodeShape; sh:targetClass ex:A; sh:property _:iri.
[] a sh:NodeShape; sh:targetClass ex:B; sh:property _:iri.
`);

        expect(report.findings).toHaveLength(1);
    });

    test("sh:datatype converting an IRI is found with data", () => {
        const report = check(
            shapeWith("sh:datatype xsd:string;") +
                "ex:a a ex:Thing; ex:v0 ex:b.",
        );

        expect(summary(report.findings)).toEqual([
            expect.stringContaining(
                'warning: rdf-lens: property "v0" (path <http://example.org/v0>, ' +
                    "shape <http://example.org/Thing>) declares sh:datatype " +
                    "xsd:string but was given the IRI <http://example.org/b>",
            ),
        ]);
    });

    test("subclass instances are extracted with the shape", () => {
        const report = check(
            shapeWith("sh:datatype xsd:string;") +
                `ex:Special <http://www.w3.org/2000/01/rdf-schema#subClassOf> ex:Thing.
                 ex:a a ex:Special; ex:v0 ex:b.`,
        );

        expect(report.focusNodes).toBe(1);
        expect(report.findings).toHaveLength(1);
    });

    test("data that does not fit its shape is an error on that node", () => {
        const report = check(
            shapeWith("sh:nodeKind sh:IRI; sh:minCount 1;") +
                `ex:a a ex:Thing; ex:v0 "a literal".
                 ex:b a ex:Thing.`,
        );

        expect(
            report.findings.map((x) => [x.level, x.focus?.value, x.message]),
        ).toEqual([
            [
                "error",
                "http://example.org/a",
                expect.stringContaining("Node kind violation"),
            ],
            [
                "error",
                "http://example.org/b",
                'Field is not defined and required, in field "v0"',
            ],
        ]);
    });

    test("a shape that cannot be read names every property at fault", () => {
        const report = check(`
[] a sh:NodeShape; sh:targetClass ex:Thing; sh:property
  [ sh:name "a"; sh:path ex:a ],
  [ sh:path ex:b; sh:datatype xsd:string ],
  [ sh:name "c"; sh:path ex:c; sh:codeType xsd:strin ],
  [ sh:name "d"; sh:path ex:d; sh:datatype xsd:string ].
`);

        expect(summary(report.findings)).toEqual([
            "error: The shape for <http://example.org/Thing> cannot be read: " +
                'property "a" (path <http://example.org/a>, shape ' +
                "<http://example.org/Thing>) has no sh:class, sh:nodeKind, " +
                "sh:codeType or sh:datatype",
            "error: The shape for <http://example.org/Thing> cannot be read: " +
                "a property (path <http://example.org/b>, shape " +
                "<http://example.org/Thing>) has no sh:name or sh:codeIdentifier",
            expect.stringContaining(
                'error: rdf-lens: Unsupported sh:codeType: property "c"',
            ),
        ]);
    });

    test("a class without a shape is taken as is and listed", () => {
        const report = check(
            shapeWith("sh:class ex:Writer;") + "ex:a a ex:Thing; ex:v0 ex:w.",
        );

        expect(report.findings).toEqual([]);
        expect(report.unchecked.map((x) => x.value)).toEqual([
            "http://example.org/Writer",
        ]);
    });

    test("shapes without a target class are not counted", () => {
        const report = check(`
[] a sh:NodeShape; sh:targetSubjectsOf ex:implements; sh:property
  [ sh:name "file"; sh:path ex:file; sh:datatype xsd:string ].
`);

        expect(report.shapes).toBe(0);
        expect(report.findings).toEqual([]);
    });

    test("puts back the warning handler it replaces", () => {
        const seen: string[] = [];
        setWarningHandler((message) => seen.push(message));
        try {
            check(
                shapeWith("sh:datatype xsd:iri;") +
                    "ex:a a ex:Thing; ex:v0 ex:b.",
            );
            expect(seen).toEqual([]);

            const previous = setWarningHandler();
            expect(previous).toBeDefined();
            previous!("after");
            expect(seen).toEqual(["after"]);
        } finally {
            setWarningHandler();
        }
    });
});

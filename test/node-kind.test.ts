import { afterEach, describe, expect, test, vi } from "vitest";
import { Parser } from "n3";
import { DataFactory, NamedNode } from "rdf-data-factory";
import type { Quad, Term } from "@rdfjs/types";
import { RDF } from "@treecg/types";
import { extractShapes } from "../src/shacl";

const df = new DataFactory();

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfl: <https://w3id.org/rdf-lens/ontology#> .
@prefix ex: <http://example.org/> .
`;

const parse = (turtle: string, baseIRI?: string) =>
    new Parser({ baseIRI }).parse(prefixes + turtle);

const shapeWith = (constraint: string, name = 'sh:name "value";') => `
[] a sh:NodeShape;
  sh:targetClass ex:Thing;
  sh:property [ ${name} sh:path ex:value; sh:maxCount 1; ${constraint} ].
`;

const thing = (value: string) => `<foobar> a ex:Thing; ex:value ${value}.`;
const env = (key: string) =>
    thing(`[ a rdfl:EnvVariable; rdfl:envKey "${key}" ]`);

const BASE = "http://config.example/dir/pipeline.ttl";
const RELATIVE = thing("<./relative/thing>");
const RESOLVED = "http://config.example/dir/relative/thing";

function extractQuads(shapes: string, quads: Quad[]): unknown {
    const typeQuad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;
    const object = <Record<string, unknown>>extractShapes(parse(shapes)).lenses[
        typeQuad.object.value
    ].execute({
        id: typeQuad.subject,
        quads,
    });
    return object.value;
}

const extract = (shapes: string, data: string, baseIRI?: string) =>
    extractQuads(shapes, parse(data, baseIRI));

// Lens failures can arrive as an array of errors, so stringify what is thrown
function errorOf(fn: () => unknown): string {
    try {
        fn();
    } catch (error) {
        return String(error);
    }
    throw new Error("expected the extraction to fail");
}

function warningsOf(fn: () => unknown): string[] {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fn();
    return warn.mock.calls.map((x) => String(x[0]));
}

afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["RDF_LENS_TEST"];
});

describe("Extracting terms", () => {
    test.each([
        [
            "sh:nodeKind sh:IRI;",
            thing("ex:target"),
            { termType: "NamedNode", value: "http://example.org/target" },
        ],
        [
            "sh:nodeKind sh:Literal;",
            thing('"hello"@en'),
            { termType: "Literal", value: "hello", language: "en" },
        ],
        [
            "sh:nodeKind sh:BlankNode;",
            thing("[ ex:other 1 ]"),
            { termType: "BlankNode" },
        ],
        [
            "sh:nodeKind sh:IRIOrLiteral;",
            thing("ex:target"),
            { termType: "NamedNode" },
        ],
        [
            "sh:nodeKind sh:IRIOrLiteral;",
            thing('"hello"'),
            { termType: "Literal" },
        ],
    ])("%s on %s", (constraint, data, expected) => {
        expect(extract(shapeWith(constraint), data)).toMatchObject(expected);
    });

    test.each([
        ["sh:nodeKind sh:Literal; sh:datatype xsd:integer;", thing("42"), 42],
        ["sh:nodeKind sh:Literal; rdfl:codeType xsd:integer;", thing("42"), 42],
        ["rdfl:codeType xsd:string;", thing('"plain"'), "plain"],
        ["rdfl:codeType xsd:string;", RELATIVE, RESOLVED],
        ["sh:nodeKind sh:IRI; rdfl:codeType xsd:string;", RELATIVE, RESOLVED],
    ])("%s converts %s", (constraint, data, expected) => {
        expect(extract(shapeWith(constraint), data, BASE)).toBe(expected);
    });

    const SPARQL = "https://example.org/sparql";
    test.each([
        [
            "sh:nodeKind sh:IRIOrLiteral; rdfl:codeType xsd:anyURI;",
            thing(`"${SPARQL}"`),
        ],
        [
            "sh:nodeKind sh:IRIOrLiteral; rdfl:codeType xsd:anyURI;",
            thing(`<${SPARQL}>`),
        ],
        ["rdfl:codeType xsd:anyURI;", thing(`"${SPARQL}"`)],
    ])("%s makes an IRI of %s", (constraint, data) => {
        expect(extract(shapeWith(constraint), data)).toMatchObject({
            termType: "NamedNode",
            value: SPARQL,
        });
    });

    test.each([thing('"not an iri"'), thing("[ ex:other 1 ]")])(
        "rdfl:codeType xsd:anyURI rejects %s",
        (data) => {
            expect(
                errorOf(() =>
                    extract(shapeWith("rdfl:codeType xsd:anyURI;"), data),
                ),
            ).toContain("Expected an IRI");
        },
    );

    test("Multi valued properties", () => {
        const shape = shapeWith("sh:nodeKind sh:IRI;").replace(
            "sh:maxCount 1;",
            "",
        );
        const values = <Term[]>extract(shape, thing("ex:a, ex:b"));

        expect(values.map((x) => x.value).sort()).toEqual([
            "http://example.org/a",
            "http://example.org/b",
        ]);
    });

    test("A literal keeps its base direction", () => {
        // n3 does not parse directional literals, so build the data by hand
        const subject = df.namedNode("http://example.org/foobar");
        const quads = [
            df.quad(
                subject,
                RDF.terms.type,
                df.namedNode("http://example.org/Thing"),
            ),
            df.quad(
                subject,
                df.namedNode("http://example.org/value"),
                df.literal("hello", { language: "en", direction: "rtl" }),
            ),
        ];

        expect(
            extractQuads(shapeWith("sh:nodeKind sh:Literal;"), quads),
        ).toMatchObject({ language: "en", direction: "rtl" });
    });

    test.each([
        ["sh:nodeKind sh:IRI;", "sh:datatype xsd:iri;", thing("ex:target")],
        [
            "sh:nodeKind sh:IRI; rdfl:codeType xsd:string;",
            "sh:datatype xsd:string;",
            RELATIVE,
        ],
        ["rdfl:codeType rdfl:Term;", "sh:datatype xsd:any;", thing("ex:a")],
    ])("%s extracts what %s does", (replacement, old, data) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(extract(shapeWith(replacement), data, BASE)).toEqual(
            extract(shapeWith(old), data, BASE),
        );
    });

    test("rdfl:Term hands back the parsed term, a node kind rebuilds it", () => {
        const quads = parse(thing("ex:target"));
        const raw = extractQuads(shapeWith("rdfl:codeType rdfl:Term;"), quads);
        const rebuilt = extractQuads(shapeWith("sh:nodeKind sh:IRI;"), quads);

        expect(raw).toBe(quads[1].object);
        expect(raw).not.toBeInstanceOf(NamedNode);
        expect(rebuilt).toBeInstanceOf(NamedNode);
    });
});

describe("Node kind violations", () => {
    test.each([
        "sh:nodeKind sh:IRI;",
        "sh:nodeKind sh:IRI; sh:datatype xsd:string;",
        "sh:nodeKind sh:IRI; rdfl:codeType xsd:string;",
        "sh:nodeKind sh:IRI; rdfl:codeType rdfl:Term;",
    ])("%s rejects a literal", (constraint) => {
        // Only the violation, not also that it was no environment variable
        expect(
            errorOf(() => extract(shapeWith(constraint), thing('"lit"'))),
        ).toBe("Error: Node kind violation");
    });

    test.each(["sh:IRI", "sh:BlankNodeOrIRI", "xsd:iri"])(
        "rdfl:codeType %s is not a code type",
        (codeType) => {
            expect(
                errorOf(() =>
                    extract(
                        shapeWith(`rdfl:codeType ${codeType};`),
                        thing("ex:target"),
                    ),
                ),
            ).toContain("Unsupported rdfl:codeType, use xsd:anyURI");
        },
    );

    test("An unknown node kind is reported when the field is extracted", () => {
        const shape = shapeWith("sh:nodeKind sh:Nonsense;");

        // The shape still parses, so the error can name what is wrong
        expect(extractShapes(parse(shape)).shapes.length).toBe(1);
        expect(errorOf(() => extract(shape, thing("ex:target")))).toContain(
            "Unknown sh:nodeKind",
        );
    });
});

describe("Environment variables", () => {
    const IRI = "http://example.org/from-env";

    test.each([
        ["sh:nodeKind sh:IRI;", IRI, { termType: "NamedNode", value: IRI }],
        ["sh:nodeKind sh:IRIOrLiteral;", IRI, { termType: "NamedNode" }],
        ["sh:nodeKind sh:IRIOrLiteral;", "a value", { termType: "Literal" }],
        [
            "sh:nodeKind sh:BlankNodeOrLiteral;",
            "a value",
            { termType: "Literal" },
        ],
    ])("%s makes %s a term", (constraint, value, expected) => {
        process.env["RDF_LENS_TEST"] = value;
        expect(
            extract(shapeWith(constraint), env("RDF_LENS_TEST")),
        ).toMatchObject(expected);
    });

    test("Are converted by rdfl:codeType", () => {
        process.env["RDF_LENS_TEST"] = IRI;
        expect(
            extract(
                shapeWith("sh:nodeKind sh:IRI; rdfl:codeType xsd:string;"),
                env("RDF_LENS_TEST"),
            ),
        ).toBe(IRI);
    });

    test.each([
        [IRI, { termType: "NamedNode", value: IRI }],
        ["not an iri", "Expected an IRI"],
    ])("rdfl:codeType xsd:anyURI makes an IRI of %s", (value, expected) => {
        process.env["RDF_LENS_TEST"] = value;
        const shape = shapeWith(
            "sh:nodeKind sh:IRIOrLiteral; rdfl:codeType xsd:anyURI;",
        );
        if (typeof expected === "string") {
            expect(
                errorOf(() => extract(shape, env("RDF_LENS_TEST"))),
            ).toContain(expected);
        } else {
            expect(extract(shape, env("RDF_LENS_TEST"))).toMatchObject(
                expected,
            );
        }
    });

    test.each([
        ["sh:nodeKind sh:IRI;", "not an iri", "Node kind violation"],
        ["sh:nodeKind sh:BlankNodeOrIRI;", "hello", "Node kind violation"],
        ["sh:nodeKind sh:BlankNode;", "a value", "Node kind violation"],
        ["sh:nodeKind sh:IRI;", undefined, "ENV and default are not set"],
        // Not its blank node converted by value
        ["sh:datatype xsd:string;", undefined, "ENV and default are not set"],
    ])("%s with %s fails", (constraint, value, message) => {
        if (value) process.env["RDF_LENS_TEST"] = value;
        expect(
            errorOf(() => extract(shapeWith(constraint), env("RDF_LENS_TEST"))),
        ).toContain(message);
    });
});

describe("Warnings", () => {
    test.each([
        [
            "sh:datatype xsd:iri;",
            thing("ex:target"),
            [
                "deprecated",
                "sh:nodeKind sh:IRI",
                '"value"',
                "<http://example.org/value>",
                "<http://example.org/Thing>",
            ],
        ],
        [
            "sh:datatype xsd:string;",
            thing("ex:target"),
            [
                '"value"',
                "sh:nodeKind sh:IRI (or sh:IRIOrLiteral if literals are allowed too) and rdfl:codeType xsd:string",
            ],
        ],
        [
            "sh:datatype xsd:string;",
            thing("[ ex:other 1 ]"),
            [
                "a blank node",
                "sh:nodeKind sh:BlankNode (or sh:BlankNodeOrLiteral",
            ],
        ],
        [
            "sh:nodeKind sh:IRI; sh:datatype xsd:string;",
            thing("ex:target"),
            ["Use rdfl:codeType xsd:string instead of sh:datatype xsd:string"],
        ],
        [
            "sh:datatype xsd:integer; rdfl:codeType xsd:string;",
            thing("4"),
            ["declares both"],
        ],
    ])("%s on %s warns once", (constraint, data, expected) => {
        const warnings = warningsOf(() => extract(shapeWith(constraint), data));

        expect(warnings).toHaveLength(1);
        for (const part of expected) expect(warnings[0]).toContain(part);
    });

    test.each([
        ["sh:datatype xsd:string;", thing('"an ordinary string"')],
        ["sh:datatype xsd:string;", env("RDF_LENS_TEST")],
        ["sh:datatype xsd:any;", thing("ex:target")],
        ["sh:nodeKind sh:IRI;", thing("ex:target")],
        ["sh:nodeKind sh:IRI; rdfl:codeType xsd:string;", thing("ex:target")],
    ])("%s on %s does not warn", (constraint, data) => {
        process.env["RDF_LENS_TEST"] = "a value";
        expect(warningsOf(() => extract(shapeWith(constraint), data))).toEqual(
            [],
        );
    });

    test("Names a property by its sh:codeIdentifier", () => {
        const shape = shapeWith(
            "sh:datatype xsd:string;",
            'sh:codeIdentifier "value";',
        );
        const warnings = warningsOf(() => extract(shape, thing("ex:target")));

        expect(warnings[0]).toContain('"value"');
    });

    test("Once per property, not once per value", () => {
        const shape = shapeWith("sh:datatype xsd:string;").replace(
            "sh:maxCount 1;",
            "",
        );
        const lens = extractShapes(parse(shape)).lenses[
            "http://example.org/Thing"
        ];
        const quads = parse(thing("ex:a, ex:b, ex:c"));

        const warnings = warningsOf(() => {
            lens.execute({ id: quads[0].subject, quads });
            lens.execute({ id: quads[0].subject, quads });
        });
        expect(warnings).toHaveLength(1);
    });
});

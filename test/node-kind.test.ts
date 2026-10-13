import { afterEach, describe, expect, test, vi } from "vitest";
import { Parser } from "n3";
import { DataFactory, NamedNode } from "rdf-data-factory";
import type { Quad, Term } from "@rdfjs/types";
import { RDF, XSD } from "@treecg/types";
import { LensError } from "../src/lens";
import { envReplace, extractShapes, setWarningHandler } from "../src/shacl";

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
const env = (key: string, datatype?: string) =>
    thing(
        `[ a rdfl:EnvVariable; rdfl:envKey "${key}"` +
            (datatype ? `; rdfl:datatype ${datatype}` : "") +
            " ]",
    );

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
        ["sh:nodeKind sh:Literal; sh:codeType xsd:integer;", thing("42"), 42],
        ["sh:codeType xsd:string;", thing('"plain"'), "plain"],
        ["sh:codeType xsd:string;", RELATIVE, RESOLVED],
        ["sh:nodeKind sh:IRI; sh:codeType xsd:string;", RELATIVE, RESOLVED],
        ["sh:datatype xsd:integer; sh:codeType xsd:string;", thing("4"), "4"],
    ])("%s converts %s", (constraint, data, expected) => {
        expect(extract(shapeWith(constraint), data, BASE)).toBe(expected);
    });

    const SPARQL = "https://example.org/sparql";
    test.each([
        [
            "sh:nodeKind sh:IRIOrLiteral; sh:codeType xsd:anyURI;",
            thing(`"${SPARQL}"`),
        ],
        [
            "sh:nodeKind sh:IRIOrLiteral; sh:codeType xsd:anyURI;",
            thing(`<${SPARQL}>`),
        ],
        ["sh:codeType xsd:anyURI;", thing(`"${SPARQL}"`)],
    ])("%s makes an IRI of %s", (constraint, data) => {
        expect(extract(shapeWith(constraint), data)).toMatchObject({
            termType: "NamedNode",
            value: SPARQL,
        });
    });

    test.each([thing('"not an iri"'), thing("[ ex:other 1 ]")])(
        "sh:codeType xsd:anyURI rejects %s",
        (data) => {
            expect(
                errorOf(() =>
                    extract(shapeWith("sh:codeType xsd:anyURI;"), data),
                ),
            ).toContain("Expected an IRI");
        },
    );

    test.each([
        "localhost:8080",
        "localhost:8080/sparql",
        "C:\\data\\in.ttl",
        "relative/path",
    ])(
        "sh:codeType xsd:anyURI does not take the string %s for an IRI",
        (value) => {
            expect(
                errorOf(() =>
                    extract(
                        shapeWith("sh:codeType xsd:anyURI;"),
                        thing(JSON.stringify(value)),
                    ),
                ),
            ).toContain("Expected an IRI");
        },
    );

    test.each([
        "urn:isbn:0451450523",
        "mailto:someone@example.org",
        "http://localhost:8080/sparql",
        "file:///data/in.ttl",
    ])("sh:codeType xsd:anyURI takes the string %s for an IRI", (value) => {
        expect(
            extract(
                shapeWith("sh:codeType xsd:anyURI;"),
                thing(JSON.stringify(value)),
            ),
        ).toMatchObject({ termType: "NamedNode", value });
    });

    test.each([
        [
            "sh:codeType xsd:anyURI;",
            { termType: "NamedNode", value: "http://example.org/target" },
        ],
        ["sh:codeType xsd:string;", "http://example.org/target"],
    ])("sh:codeType goes before sh:class: %s", (codeType, expected) => {
        const shape = shapeWith(`sh:class ex:Thing; ${codeType}`);

        expect(extract(shape, thing("ex:target"))).toEqual(
            typeof expected === "string"
                ? expected
                : expect.objectContaining(expected),
        );
        expect(
            extract(shapeWith("sh:class ex:Thing;"), thing("ex:target")),
        ).toEqual({ value: undefined });
    });

    test("sh:datatype xsd:iri next to a node kind reads IRIs like xsd:anyURI", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        expect(
            extract(
                shapeWith("sh:nodeKind sh:IRIOrLiteral; sh:datatype xsd:iri;"),
                thing('"https://example.org/sparql"'),
            ),
        ).toMatchObject({
            termType: "NamedNode",
            value: "https://example.org/sparql",
        });
    });

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
            "sh:nodeKind sh:IRI; sh:codeType xsd:string;",
            "sh:datatype xsd:string;",
            RELATIVE,
        ],
        ["sh:codeType rdfl:Term;", "sh:datatype xsd:any;", thing("ex:a")],
    ])("%s extracts what %s does", (replacement, old, data) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        expect(extract(shapeWith(replacement), data, BASE)).toEqual(
            extract(shapeWith(old), data, BASE),
        );
    });

    test("rdfl:Term hands back the parsed term, a node kind rebuilds it", () => {
        const quads = parse(thing("ex:target"));
        const raw = extractQuads(shapeWith("sh:codeType rdfl:Term;"), quads);
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
        "sh:nodeKind sh:IRI; sh:codeType xsd:string;",
        "sh:nodeKind sh:IRI; sh:codeType rdfl:Term;",
    ])("%s rejects a literal", (constraint) => {
        // Only the violation, not also that it was no environment variable,
        // naming the property and what it was given
        expect(
            errorOf(() => extract(shapeWith(constraint), thing('"lit"'))),
        ).toBe(
            'Error: Node kind violation: property "value" (path ' +
                "<http://example.org/value>, shape <http://example.org/Thing>) " +
                'expects sh:IRI, found the literal "lit"',
        );
    });

    test.each([
        ["sh:IRI", "a node kind, which belongs in sh:nodeKind"],
        ["sh:BlankNodeOrIRI", "a node kind, which belongs in sh:nodeKind"],
        ["xsd:iri", "use xsd:anyURI for an IRI"],
        ["xsd:strin", "expected one of xsd:string, xsd:integer"],
        ["xsd:int", "expected one of xsd:string, xsd:integer"],
    ])("sh:codeType %s is not a code type", (codeType, reason) => {
        const shape = shapeWith(`sh:codeType ${codeType};`);

        // Warned about when the shape is read, thrown once a value is extracted
        const warnings = warningsOf(() => extractShapes(parse(shape)));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(reason);
        expect(errorOf(() => extract(shape, thing("ex:target")))).toContain(
            'Unsupported sh:codeType: property "value"',
        );
    });

    test("An unknown node kind is reported when the field is extracted", () => {
        const shape = shapeWith("sh:nodeKind sh:Nonsense;");

        // The shape still parses, so the error can name what is wrong, and a
        // warning names it even when no value comes along
        const warnings = warningsOf(() =>
            expect(extractShapes(parse(shape)).shapes.length).toBe(1),
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("Unknown sh:nodeKind");
        expect(errorOf(() => extract(shape, thing("ex:target")))).toContain(
            "Unknown sh:nodeKind",
        );
    });

    test("sh:nodeKind is enforced next to sh:class", () => {
        const shape = shapeWith(
            "sh:class ex:Thing; sh:nodeKind sh:BlankNodeOrIRI;",
        );

        expect(errorOf(() => extract(shape, thing('"lit"')))).toContain(
            'Node kind violation: property "value"',
        );
        expect(extract(shape, thing("[ ex:other 1 ]"))).toEqual({
            value: undefined,
        });
    });

    test("An error lists only the field it is in", () => {
        const shape = `
[] a sh:NodeShape;
  sh:targetClass ex:Thing;
  sh:property [ sh:name "first"; sh:path ex:first; sh:maxCount 1; sh:datatype xsd:string ],
    [ sh:name "value"; sh:path ex:value; sh:maxCount 1; sh:nodeKind sh:IRI ].
`;
        const quads = parse(
            '<foobar> a ex:Thing; ex:first "x"; ex:value "lit".',
        );
        let error: LensError | undefined;
        try {
            extractQuads(shape, quads);
        } catch (ex) {
            error = <LensError>ex;
        }

        const fields = error!.lineage.filter(
            (x) => x.name === "processing field",
        );
        expect(fields).toEqual([
            {
                name: "processing field",
                opts: expect.objectContaining({ name: "value" }),
            },
        ]);
    });
});

describe("Environment variables", () => {
    const IRI = "http://example.org/from-env";

    test.each([
        ["sh:nodeKind sh:IRI;", IRI, { termType: "NamedNode", value: IRI }],
        ["sh:nodeKind sh:IRIOrLiteral;", IRI, { termType: "NamedNode" }],
        ["sh:nodeKind sh:IRIOrLiteral;", "a value", { termType: "Literal" }],
        // A host and port is no IRI, though it reads as a scheme and a path
        [
            "sh:nodeKind sh:IRIOrLiteral;",
            "localhost:8080",
            { termType: "Literal" },
        ],
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

    test("Are converted by sh:codeType", () => {
        process.env["RDF_LENS_TEST"] = IRI;
        expect(
            extract(
                shapeWith("sh:nodeKind sh:IRI; sh:codeType xsd:string;"),
                env("RDF_LENS_TEST"),
            ),
        ).toBe(IRI);
    });

    test("envReplace puts a typed literal in place of a typed variable", () => {
        process.env["RDF_LENS_TEST"] = "42";
        const replaced = envReplace().execute(
            parse(env("RDF_LENS_TEST", "xsd:integer")),
        );
        const value = replaced.find(
            (q) => q.predicate.value === "http://example.org/value",
        )!.object;

        expect(value).toMatchObject({
            termType: "Literal",
            value: "42",
            datatype: { value: XSD.integer },
        });
    });

    test.each([
        [IRI, { termType: "NamedNode", value: IRI }],
        ["not an iri", "Expected an IRI"],
    ])("sh:codeType xsd:anyURI makes an IRI of %s", (value, expected) => {
        process.env["RDF_LENS_TEST"] = value;
        const shape = shapeWith(
            "sh:nodeKind sh:IRIOrLiteral; sh:codeType xsd:anyURI;",
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
        [
            "sh:nodeKind sh:IRI;",
            "localhost:8080",
            'found environment variable RDF_LENS_TEST, which holds "localhost:8080"',
        ],
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
                "sh:nodeKind sh:IRIOrLiteral (or sh:IRI if only IRIs are expected) and sh:codeType xsd:string",
            ],
        ],
        [
            "sh:datatype xsd:string;",
            thing("[ ex:other 1 ]"),
            [
                "a blank node",
                "sh:nodeKind sh:BlankNodeOrLiteral (or sh:BlankNode",
            ],
        ],
        [
            "sh:datatype xsd:iri;",
            thing("[ ex:other 1 ]"),
            ["deprecated", "label", "sh:nodeKind sh:BlankNodeOrIRI"],
        ],
        [
            "sh:datatype xsd:iri;",
            thing('"https://example.org/sparql"'),
            [
                "deprecated",
                "sh:nodeKind sh:IRIOrLiteral and sh:codeType xsd:anyURI",
            ],
        ],
        [
            "sh:nodeKind sh:IRIOrLiteral; sh:datatype xsd:iri;",
            thing("ex:target"),
            ["deprecated", "use sh:codeType xsd:anyURI instead"],
        ],
        [
            "sh:codeType xsd:string;",
            thing("[ ex:other 1 ]"),
            ["reads its label", "Add sh:nodeKind"],
        ],
        [
            "sh:nodeKind sh:IRI; sh:datatype xsd:string;",
            thing("ex:target"),
            ["Use sh:codeType xsd:string instead of sh:datatype xsd:string"],
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
        ["sh:nodeKind sh:IRI; sh:codeType xsd:string;", thing("ex:target")],
        // sh:datatype describes the data, sh:codeType what code receives
        ["sh:datatype xsd:integer; sh:codeType xsd:string;", thing("4")],
        ["sh:class ex:Thing; sh:codeType xsd:anyURI;", thing("ex:target")],
    ])("%s on %s does not warn", (constraint, data) => {
        process.env["RDF_LENS_TEST"] = "a value";
        expect(warningsOf(() => extract(shapeWith(constraint), data))).toEqual(
            [],
        );
    });

    test("sh:datatype xsd:iri is only warned about once it extracts a value", () => {
        expect(
            warningsOf(() =>
                extractShapes(parse(shapeWith("sh:datatype xsd:iri;"))),
            ),
        ).toEqual([]);
    });

    test("Once per kind of term, as each has its own replacement", () => {
        const shape = shapeWith("sh:datatype xsd:iri;").replace(
            "sh:maxCount 1;",
            "",
        );
        const warnings = warningsOf(() =>
            extract(shape, thing("ex:a, [ ex:other 1 ], ex:b")),
        );

        expect(warnings).toHaveLength(2);
        expect(warnings.join("\n")).toContain("sh:nodeKind sh:IRI instead");
        expect(warnings.join("\n")).toContain("sh:BlankNodeOrIRI");
    });

    test("setWarningHandler routes warnings away from the console", () => {
        const messages: string[] = [];
        const consoleWarn = vi.spyOn(console, "warn");
        setWarningHandler((message) => messages.push(message));
        try {
            extract(shapeWith("sh:datatype xsd:string;"), thing("ex:target"));
        } finally {
            setWarningHandler();
        }

        expect(messages).toHaveLength(1);
        expect(consoleWarn).not.toHaveBeenCalled();
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

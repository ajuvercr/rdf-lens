import { afterEach, describe, expect, test, vi } from "vitest";
import { Parser } from "n3";
import { RDF } from "@treecg/types";
import { extractShapes } from "../src/shacl";

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfl: <https://w3id.org/rdf-lens/ontology#> .
@prefix ex: <http://example.org/> .
`;

const BASE = "http://config.example/dir/pipeline.ttl";

const parse = (turtle: string, baseIRI?: string) =>
    new Parser({ baseIRI }).parse(prefixes + turtle);

function extract(
    shapes: string,
    data: string,
    baseIRI?: string,
): Record<string, unknown> {
    const output = extractShapes(parse(shapes));
    const quads = parse(data, baseIRI);
    const typeQuad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;

    return <Record<string, unknown>>output.lenses[
        typeQuad.object.value
    ].execute({
        id: typeQuad.subject,
        quads,
    });
}

const shapeWith = (constraint: string) => `
[] a sh:NodeShape;
  sh:targetClass ex:Thing;
  sh:property [
    sh:name "value";
    sh:path ex:value;
    sh:maxCount 1;
    ${constraint}
  ].
`;

afterEach(() => {
    vi.restoreAllMocks();
});

describe("sh:nodeKind", () => {
    test("sh:IRI extracts the named node", () => {
        const object = extract(
            shapeWith("sh:nodeKind sh:IRI;"),
            "<foobar> a ex:Thing; ex:value ex:target.",
        );

        expect(object.value).toMatchObject({
            termType: "NamedNode",
            value: "http://example.org/target",
        });
    });

    test("sh:IRI is a drop in replacement for sh:datatype xsd:iri", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const data = "<foobar> a ex:Thing; ex:value ex:target.";
        const withNodeKind = extract(shapeWith("sh:nodeKind sh:IRI;"), data);
        const withDatatype = extract(shapeWith("sh:datatype xsd:iri;"), data);

        expect(withNodeKind).toEqual(withDatatype);
    });

    test("sh:Literal extracts the literal, keeping datatype and language", () => {
        const object = extract(
            shapeWith("sh:nodeKind sh:Literal;"),
            `
<foobar> a ex:Thing; ex:value "hello"@en.
`,
        );

        expect(object.value).toMatchObject({
            termType: "Literal",
            value: "hello",
            language: "en",
        });
    });

    test("sh:BlankNode extracts the blank node", () => {
        const object = extract(
            shapeWith("sh:nodeKind sh:BlankNode;"),
            "<foobar> a ex:Thing; ex:value [ ex:other 1 ].",
        );

        expect(object.value).toMatchObject({ termType: "BlankNode" });
    });

    test("Union kinds accept either term type", () => {
        const shape = shapeWith("sh:nodeKind sh:IRIOrLiteral;");

        expect(
            extract(shape, "<foobar> a ex:Thing; ex:value ex:target.").value,
        ).toMatchObject({ termType: "NamedNode" });
        expect(
            extract(
                shape,
                `
<foobar> a ex:Thing; ex:value "hello".
`,
            ).value,
        ).toMatchObject({ termType: "Literal" });
    });

    // Lens failures arrive as an array of the errors each alternative raised,
    // so inspect the thrown value rather than matching on an Error
    function errorOf(fn: () => unknown): string {
        try {
            fn();
        } catch (error) {
            return String(error);
        }
        throw new Error("expected the extraction to fail");
    }

    test("A value of the wrong kind is an error", () => {
        const error = errorOf(() =>
            extract(
                shapeWith("sh:nodeKind sh:IRI;"),
                `
<foobar> a ex:Thing; ex:value "not an iri".
`,
            ),
        );

        expect(error).toContain("Node kind violation");
    });

    test("An unknown node kind is reported when the field is extracted", () => {
        const shape = shapeWith("sh:nodeKind sh:Nonsense;");

        // The shape itself still parses, so the error can name what is wrong
        // instead of the shape quietly not existing
        expect(extractShapes(parse(shape)).shapes.length).toBe(1);

        const error = errorOf(() =>
            extract(shape, "<foobar> a ex:Thing; ex:value ex:target."),
        );
        expect(error).toContain("Unknown sh:nodeKind");
    });

    test("sh:datatype wins when a property carries both", () => {
        const object = extract(
            shapeWith("sh:nodeKind sh:Literal; sh:datatype xsd:integer;"),
            "<foobar> a ex:Thing; ex:value 42.",
        );

        expect(object.value).toBe(42);
    });

    test("Node kinds work for multi valued properties", () => {
        const object = extract(
            `
[] a sh:NodeShape;
  sh:targetClass ex:Thing;
  sh:property [
    sh:name "values";
    sh:path ex:value;
    sh:nodeKind sh:IRI;
  ].
`,
            "<foobar> a ex:Thing; ex:value ex:a, ex:b.",
        );

        expect(
            (<{ value: string }[]>object.values).map((x) => x.value).sort(),
        ).toEqual(["http://example.org/a", "http://example.org/b"]);
    });

    test("An environment variable resolves to an IRI", () => {
        process.env["RDF_LENS_TEST_IRI"] = "http://example.org/from-env";

        const object = extract(
            shapeWith("sh:nodeKind sh:IRI;"),
            `
<foobar> a ex:Thing; ex:value [
  a rdfl:EnvVariable;
  rdfl:envKey "RDF_LENS_TEST_IRI";
].
`,
        );

        expect(object.value).toMatchObject({
            termType: "NamedNode",
            value: "http://example.org/from-env",
        });
    });
});

describe("sh:datatype xsd:iri deprecation", () => {
    test("Warns, and still extracts the IRI", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const object = extract(
            shapeWith("sh:datatype xsd:iri;"),
            "<foobar> a ex:Thing; ex:value ex:target.",
        );

        expect(object.value).toMatchObject({
            termType: "NamedNode",
            value: "http://example.org/target",
        });
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain("sh:nodeKind sh:IRI");
    });

    test("The warning names the property, its path and its shape", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        extract(
            shapeWith("sh:datatype xsd:iri;"),
            "<foobar> a ex:Thing; ex:value ex:target.",
        );

        expect(warn.mock.calls[0][0]).toContain(JSON.stringify("value"));
        expect(warn.mock.calls[0][0]).toContain("http://example.org/value");
        // The target class, so a warning from a large shapes file points at
        // the shape and not only at a path a dozen shapes may share
        expect(warn.mock.calls[0][0]).toContain("http://example.org/Thing");
    });

    test("Other datatypes do not warn", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        extract(
            shapeWith("sh:datatype xsd:string;"),
            `
<foobar> a ex:Thing; ex:value "hello".
`,
        );

        expect(warn).not.toHaveBeenCalled();
    });

    test("Plain predicate paths do not warn", () => {
        // ShaclPredicatePath reads the path IRI through xsd:iri internally,
        // which must not be reported as a deprecated shape
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        extract(
            shapeWith("sh:nodeKind sh:IRI;"),
            "<foobar> a ex:Thing; ex:value ex:target.",
        );

        expect(warn).not.toHaveBeenCalled();
    });
});

describe("rdfl:datatype", () => {
    // The config author writes a relative IRI so the parser resolves it
    // against the base, the code reading it wants an ordinary string
    const relative = `
<foobar> a ex:Thing; ex:value <./relative/thing>.
`;
    const resolved = "http://config.example/dir/relative/thing";

    test("Converts the term a node kind allows", () => {
        const object = extract(
            shapeWith("sh:nodeKind sh:IRI; rdfl:datatype xsd:string;"),
            relative,
            BASE,
        );

        expect(object.value).toBe(resolved);
    });

    test("Extracts what the sh:datatype xsd:string hijack extracts today", () => {
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const withNodeKind = extract(
            shapeWith("sh:nodeKind sh:IRI; rdfl:datatype xsd:string;"),
            relative,
            BASE,
        );
        const hijacked = extract(
            shapeWith("sh:datatype xsd:string;"),
            relative,
            BASE,
        );

        expect(withNodeKind).toEqual(hijacked);
    });

    test("The node kind is still enforced", () => {
        let error = "";
        try {
            extract(
                shapeWith("sh:nodeKind sh:IRI; rdfl:datatype xsd:string;"),
                `
<foobar> a ex:Thing; ex:value "not an iri".
`,
            );
        } catch (e) {
            error = String(e);
        }

        expect(error).toContain("Node kind violation");
    });

    test("Converts any term when used without a node kind", () => {
        const shape = shapeWith("rdfl:datatype xsd:string;");

        expect(extract(shape, relative, BASE).value).toBe(resolved);
        expect(
            extract(
                shape,
                `
<foobar> a ex:Thing; ex:value "plain".
`,
            ).value,
        ).toBe("plain");
    });

    test("Converts a literal alongside sh:nodeKind sh:Literal", () => {
        const object = extract(
            shapeWith("sh:nodeKind sh:Literal; rdfl:datatype xsd:integer;"),
            "<foobar> a ex:Thing; ex:value 42.",
        );

        expect(object.value).toBe(42);
    });

    test("An environment variable is converted too", () => {
        process.env["RDF_LENS_TEST_ENV_IRI"] = "http://example.org/from-env";

        const object = extract(
            shapeWith("sh:nodeKind sh:IRI; rdfl:datatype xsd:string;"),
            `
<foobar> a ex:Thing; ex:value [
  a rdfl:EnvVariable;
  rdfl:envKey "RDF_LENS_TEST_ENV_IRI";
].
`,
        );

        expect(object.value).toBe("http://example.org/from-env");
    });
});

describe("sh:datatype holding IRIs", () => {
    test("Warns, naming the property and the replacement", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const object = extract(
            shapeWith("sh:datatype xsd:string;"),
            "<foobar> a ex:Thing; ex:value ex:target.",
        );

        expect(object.value).toBe("http://example.org/target");
        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain(JSON.stringify("value"));
        expect(warn.mock.calls[0][0]).toContain("sh:nodeKind sh:IRI");
        expect(warn.mock.calls[0][0]).toContain("rdfl:datatype xsd:string");
    });

    test("Warns once per property, not once per value", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        const shapes = `
[] a sh:NodeShape;
  sh:targetClass ex:Thing;
  sh:property [
    sh:name "values";
    sh:path ex:value;
    sh:datatype xsd:string;
  ].
`;
        const output = extractShapes(parse(shapes));
        const quads = parse("<foobar> a ex:Thing; ex:value ex:a, ex:b, ex:c.");
        const lens = output.lenses["http://example.org/Thing"];

        lens.execute({ id: quads[0].subject, quads });
        lens.execute({ id: quads[0].subject, quads });

        expect(warn).toHaveBeenCalledOnce();
    });

    test("Literal values do not warn", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        extract(
            shapeWith("sh:datatype xsd:string;"),
            `
<foobar> a ex:Thing; ex:value "an ordinary string".
`,
        );

        expect(warn).not.toHaveBeenCalled();
    });

    test("Environment variables do not warn", () => {
        process.env["RDF_LENS_TEST_PLAIN"] = "a value";
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        extract(
            shapeWith("sh:datatype xsd:string;"),
            `
<foobar> a ex:Thing; ex:value [
  a rdfl:EnvVariable;
  rdfl:envKey "RDF_LENS_TEST_PLAIN";
].
`,
        );

        expect(warn).not.toHaveBeenCalled();
    });

    test("xsd:iri reports its own deprecation and nothing else", () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

        extract(
            shapeWith("sh:datatype xsd:iri;"),
            "<foobar> a ex:Thing; ex:value ex:target.",
        );

        expect(warn).toHaveBeenCalledOnce();
        expect(warn.mock.calls[0][0]).toContain("deprecated");
    });
});

import { describe, expect, test } from "vitest";
import { Parser } from "n3";
import { RDF } from "@treecg/types";
import { ApplyDict, extractShapes } from "../src/shacl";

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/> .
`;

const parse = (turtle: string) => new Parser().parse(prefixes + turtle);

/**
 * Extracts the single typed subject of the data through the shape defined for
 * its rdf:type, the way a consumer of extractShapes would.
 */
function extract(
    shapes: string,
    data: string,
    apply: ApplyDict = {},
): Record<string, unknown> {
    const output = extractShapes(parse(shapes), apply);
    const quads = parse(data);
    const typeQuad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;

    return <Record<string, unknown>>output.lenses[
        typeQuad.object.value
    ].execute({
        id: typeQuad.subject,
        quads,
    });
}

// A fetcher with nested options, like the processor shapes of RDF-Connect
const fetcherShape = `
[] a sh:NodeShape;
  sh:targetClass ex:Fetcher;
  sh:property [
    sh:name "url";
    sh:path ex:url;
    sh:datatype xsd:string;
    sh:minCount 1;
    sh:maxCount 1;
  ], [
    sh:name "options";
    sh:path ex:options;
    sh:node ex:OptionsShape;
    sh:maxCount 1;
  ].

ex:OptionsShape a sh:NodeShape;
  sh:property [
    sh:name "method";
    sh:path ex:method;
    sh:datatype xsd:string;
    sh:defaultValue "GET";
    sh:maxCount 1;
  ], [
    sh:name "retry";
    sh:path ex:retry;
    sh:node ex:RetryShape;
    sh:maxCount 1;
  ].

ex:RetryShape a sh:NodeShape;
  sh:property [
    sh:name "codes";
    sh:path ex:code;
    sh:datatype xsd:integer;
  ], [
    sh:name "max";
    sh:path ex:max;
    sh:datatype xsd:integer;
    sh:defaultValue 3;
    sh:maxCount 1;
  ].
`;

describe("sh:node", () => {
    test("builds a nested object with the node shape, two levels deep", () => {
        const object = extract(
            fetcherShape,
            `
<fetcher> a ex:Fetcher;
  ex:url "http://example.org/data";
  ex:options [
    ex:method "POST";
    ex:retry [ ex:code 404, 503; ex:max 5 ]
  ].
`,
        );

        expect(object.url).toBe("http://example.org/data");
        expect(object.options).toEqual({
            method: "POST",
            retry: { codes: expect.arrayContaining([404, 503]), max: 5 },
        });
    });

    test("needs no rdf:type on the value, nor a target class on the shape", () => {
        const output = extractShapes(parse(fetcherShape));

        expect(output.shapes.map((shape) => shape.ty.value)).toEqual([
            "http://example.org/Fetcher",
        ]);
        expect(output.nodeShapes.map((shape) => shape.id).sort()).toEqual([
            "http://example.org/OptionsShape",
            "http://example.org/RetryShape",
        ]);
        expect(output.lenses["http://example.org/OptionsShape"]).toBeDefined();
    });

    test("applies the defaults of the node shape", () => {
        const object = extract(
            fetcherShape,
            `
<fetcher> a ex:Fetcher;
  ex:url "http://example.org/data";
  ex:options [ ex:retry [ ex:code 429 ] ].
`,
        );

        expect(object.options).toEqual({
            method: "GET",
            retry: { codes: [429], max: 3 },
        });
    });

    test("a default node is extracted with the node shape", () => {
        const object = extract(
            `
[] a sh:NodeShape;
  sh:targetClass ex:Fetcher;
  sh:property [
    sh:name "options";
    sh:path ex:options;
    sh:node ex:OptionsShape;
    sh:defaultValue [ ];
    sh:maxCount 1;
  ].

ex:OptionsShape a sh:NodeShape;
  sh:property [
    sh:name "method";
    sh:path ex:method;
    sh:datatype xsd:string;
    sh:defaultValue "GET";
    sh:maxCount 1;
  ].
`,
            `<fetcher> a ex:Fetcher.`,
        );

        expect(object).toEqual({ options: { method: "GET" } });
    });

    test("an inline blank node shape works too", () => {
        const object = extract(
            `
[] a sh:NodeShape;
  sh:targetClass ex:Line;
  sh:property [
    sh:name "points";
    sh:path ex:point;
    sh:node [
      sh:property [
        sh:name "x";
        sh:path ex:x;
        sh:datatype xsd:integer;
        sh:maxCount 1;
      ]
    ];
  ].
`,
            `<line> a ex:Line; ex:point [ ex:x 1 ], [ ex:x 2 ].`,
        );

        expect((<{ x: number }[]>object.points).map((p) => p.x).sort()).toEqual(
            [1, 2],
        );
    });

    test("goes before sh:class", () => {
        const object = extract(
            `
[] a sh:NodeShape;
  sh:targetClass ex:Thing;
  sh:property [
    sh:name "part";
    sh:path ex:part;
    sh:class ex:Part;
    sh:node ex:PartShape;
    sh:maxCount 1;
  ].

[] a sh:NodeShape;
  sh:targetClass ex:Part;
  sh:property [
    sh:name "fromClass";
    sh:path ex:value;
    sh:datatype xsd:string;
    sh:maxCount 1;
  ].

ex:PartShape a sh:NodeShape;
  sh:property [
    sh:name "fromNode";
    sh:path ex:value;
    sh:datatype xsd:string;
    sh:maxCount 1;
  ].
`,
            `<thing> a ex:Thing; ex:part [ a ex:Part; ex:value "v" ].`,
        );

        expect(object).toEqual({ part: { fromNode: "v" } });
    });

    test("a shape with a target class can be used with sh:node", () => {
        const object = extract(
            `
[] a sh:NodeShape;
  sh:targetClass ex:Line;
  sh:property [
    sh:name "start";
    sh:path ex:start;
    sh:node ex:PointShape;
    sh:maxCount 1;
  ].

ex:PointShape a sh:NodeShape;
  sh:targetClass ex:Point;
  sh:property [
    sh:name "x";
    sh:path ex:x;
    sh:datatype xsd:integer;
    sh:maxCount 1;
  ].
`,
            `<line> a ex:Line; ex:start [ ex:x 4 ].`,
        );

        expect(object).toEqual({ start: { x: 4 } });
    });

    test("the value is checked against sh:nodeKind", () => {
        const shapes = `
[] a sh:NodeShape;
  sh:targetClass ex:Fetcher;
  sh:property [
    sh:name "options";
    sh:path ex:options;
    sh:node ex:OptionsShape;
    sh:nodeKind sh:BlankNodeOrIRI;
    sh:maxCount 1;
  ].

ex:OptionsShape a sh:NodeShape;
  sh:property [
    sh:name "method";
    sh:path ex:method;
    sh:datatype xsd:string;
    sh:maxCount 1;
  ].
`;

        expect(
            extract(
                shapes,
                `<fetcher> a ex:Fetcher; ex:options [ ex:method "POST" ].`,
            ),
        ).toEqual({ options: { method: "POST" } });
        expect(() =>
            extract(shapes, `<fetcher> a ex:Fetcher; ex:options "not a node".`),
        ).toThrow(/Node kind violation/);
    });

    test("a node shape that is not defined fails once it is used", () => {
        const shapes = `
[] a sh:NodeShape;
  sh:targetClass ex:Fetcher;
  sh:property [
    sh:name "options";
    sh:path ex:options;
    sh:node ex:Typo;
    sh:maxCount 1;
  ].
`;

        expect(extractShapes(parse(shapes)).nodeShapes).toEqual([]);
        expect(extract(shapes, `<fetcher> a ex:Fetcher.`)).toEqual({
            options: undefined,
        });
        expect(() =>
            extract(shapes, `<fetcher> a ex:Fetcher; ex:options [ ].`),
        ).toThrow(/Tried extracting a node shape, but it could not be read/);
    });

    test("apply post-processes the values of a node shape", () => {
        const object = extract(
            fetcherShape,
            `
<fetcher> a ex:Fetcher;
  ex:url "http://example.org/data";
  ex:options [ ex:method "PUT" ].
`,
            {
                "http://example.org/OptionsShape": (item) =>
                    (<{ method: string }>item).method.toLowerCase(),
            },
        );

        expect(object.options).toBe("put");
    });
});

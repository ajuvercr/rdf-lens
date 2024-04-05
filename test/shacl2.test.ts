import { describe, expect, test } from "@jest/globals";
import { Quad } from "@rdfjs/types";
import { RDF } from "@treecg/types";
import { Parser } from "n3";
import { extractShapes } from "../src/shacl";
import { RDFL } from "../src/ontology";

const prefixes = `
@prefix js: <https://w3id.org/conn/js#> .
@prefix fno: <https://w3id.org/function/ontology#> .
@prefix fnom: <https://w3id.org/function/vocabulary/mapping#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> . @prefix : <https://w3id.org/conn#> .
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix dc: <http://purl.org/dc/elements/1.1/>.
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
@prefix rdfl: <https://w3id.org/rdf-lens/ontology#>.
`;

const shapes = `
${prefixes}
[] a sh:NodeShape;
  sh:targetClass js:3DPoint;
  sh:property [
    sh:datatype xsd:integer;
    sh:path js:z;
    sh:name "z";
    sh:maxCount 1;
  ].

js:3DPoint rdfs:subClassOf js:Point.

[] a sh:NodeShape;
  sh:targetClass js:Point;
  sh:property [
    sh:datatype xsd:integer;
    sh:path js:x;
    sh:name "x";
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:datatype xsd:integer;
    sh:path js:y;
    sh:name "y";
    sh:maxCount 1;
    sh:minCount 1;
  ].
  
js:JsProcessorShape a sh:NodeShape;
  sh:targetClass js:JsProcess;
  sh:property [
    sh:datatype xsd:string;
    sh:path :required;
    sh:name "required";
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:datatype xsd:string;
    sh:path :multiple;
    sh:name "multiple";
  ], [
    sh:datatype xsd:string;
    sh:path :at_least;
    sh:name "atLeast";
    sh:minCount 1;
  ], [
    sh:path :point;
    sh:class js:Point;
    sh:name "certainPoint";
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:path :point;
    sh:class rdfl:TypedExtract;
    sh:name "dataPoint";
    sh:maxCount 1;
  ].
`;

function parseQuads(inp: string): Quad[] {
  return new Parser().parse(inp);
}

describe("Shapes test", () => {
  test("Parse shapes", () => {
    const quads = parseQuads(shapes);
    const output = extractShapes(quads);
    expect(output.shapes.length).toBe(3);
  });

  test("Parse objects", () => {
    const data = `
${prefixes}
<abc> a js:JsProcess;
  :required "true";
  :multiple "one!";
  :at_least "two!";
  :point [
    a js:Point;
    js:x 5;
    js:y 42;
  ].
`;

    const output = extractShapes(parseQuads(shapes));
    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;

    const object = output.lenses[quad.object.value].execute({
      id: quad.subject,
      quads,
    });
    expect(object.required).toBe("true");
    expect(object.multiple).toEqual(["one!"]);
    expect(object.atLeast).toEqual(["two!"]);
    expect(object.certainPoint.x).toBe(5);
    expect(object.certainPoint.y).toBe(42);
    expect(object.dataPoint.x).toBe(5);
    expect(object.dataPoint.y).toBe(42);
  });

  test("Invalid objects", () => {
    const data = `
${prefixes}
<abc> a js:JsProcess;
  # :required "true";
  :multiple "one!";
  :at_least "two!";
  :point [
    a js:Point;
    js:x 5;
    js:y 42;
  ].
`;
    const output = extractShapes(parseQuads(shapes));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;

    expect(() =>
      output.lenses[quad.object.value].execute({
        id: quad.subject,
        quads,
      }),
    ).toThrow();
  });

  test("Parse subclassed objects", () => {
    const data = `
${prefixes}
<abc> a js:JsProcess;
  :required "true";
  :multiple "one!";
  :at_least "two!";
  :point [
    a js:3DPoint;
    js:x 5;
    js:y 42;
    js:z 64;
  ].
`;
    const output = extractShapes(parseQuads(shapes));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;

    const object = output.lenses[quad.object.value].execute({
      id: quad.subject,
      quads,
    });
    expect(object.dataPoint.z).toBe(64);
    expect(object.dataPoint.x).toBe(5);
    expect(object.dataPoint.y).toBe(42);
  });

  test("Parse objects without type", () => {
    const data = `
${prefixes}
<abc> a js:JsProcess;
  :required "true";
  :multiple "one!";
  :at_least "two!";
  :point [
    js:x 5;
    js:y 42;
  ].
`;
    const output = extractShapes(parseQuads(shapes));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;
    const object = output.lenses[quad.object.value].execute({
      id: quad.subject,
      quads,
    });

    expect(object.certainPoint.x).toBe(5);
    expect(object.certainPoint.y).toBe(42);
    expect(object.dataPoint).toBeUndefined();
  });

  test("Parse fake subclassed objects fail", () => {
    const data = `
${prefixes}
<abc> a js:JsProcess;
  :required "true";
  :multiple "one!";
  :at_least "two!";
  :point [
    a js:JsProcess;
    :required "true";
    :multiple "one!";
    :at_least "two!";
    :point [
      js:x 5;
      js:y 42;
    ];
  ].
`;
    const output = extractShapes(parseQuads(shapes));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;

    expect(() =>
      output.lenses[quad.object.value].execute({
        id: quad.subject,
        quads,
      }),
    ).toThrow();
  });

  test("Empty list", () => {
    const data = `
${prefixes}
<abc> a js:JsProcess;
  :required "true";
  :at_least "two!";
  :point [
    js:x 5;
    js:y 42;
  ].
`;
    const output = extractShapes(parseQuads(shapes));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;
    const object = output.lenses[quad.object.value].execute({
      id: quad.subject,
      quads,
    });
    expect(object.multiple).toEqual([]);
  });

  test("Empty list fails", () => {
    const data = `
${prefixes}
<abc> a js:JsProcess;
  :required "true";
  :point [
    js:x 5;
    js:y 42;
  ].
`;
    const output = extractShapes(parseQuads(shapes));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;
    expect(() =>
      output.lenses[quad.object.value].execute({
        id: quad.subject,
        quads,
      }),
    ).toThrow();
  });

  test("Inverse path", () => {
    const shapes = `
${prefixes}
[] a sh:NodeShape;
  sh:targetClass js:Point;
  sh:property [
    sh:datatype xsd:string;
    sh:path [ sh:inversePath  js:x ];
    sh:name "x";
    sh:maxCount 1;
  ], [
    sh:datatype xsd:string;
    sh:path [ sh:inversePath  ( js:x js:y ) ];
    sh:name "y";
    sh:maxCount 1;
  ].
`;
    const data = `
${prefixes}
<abc> a js:Point.

<x> js:x <abc>.
<y> js:x [ js:y <abc> ].
`;
    const output = extractShapes(parseQuads(shapes));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;
    const obj = output.lenses[quad.object.value].execute({
      id: quad.subject,
      quads,
    });
    expect(obj.x).toBe("x");
    expect(obj.y).toBe("y");
  });

  describe("Testing custom RDFL lenses", () => {
    const shape = `
${prefixes}

[] a sh:NodeShape;
  sh:targetClass js:Point;
  sh:property [
    sh:class rdfl:CBD;
    sh:path <cbd>;
    sh:name "cbd";
    sh:maxCount 1;
  ], [
    sh:datatype xsd:iri;
    sh:path ( );
    sh:name "id";
    sh:maxCount 1;
  ], [
    sh:class rdfl:PathLens;
    sh:path <path>;
    sh:name "path";
    sh:maxCount 1;
  ], [
    sh:class rdfl:Context;
    sh:path <context>;
    sh:name "context";
    sh:maxCount 1;
  ], [
    sh:class rdfl:TypedExtract;
    sh:path <custom>;
    sh:name "custom";
    sh:maxCount 1;
  ].

[] a sh:NodeShape;
  sh:targetClass js:MyCustomClass;
  sh:property [
    sh:datatype xsd:string;
    sh:path js:value;
    sh:name "value";
    sh:maxCount 1;
    sh:minCount 1;
].
`;
    const data = `
${prefixes}
<abc> a js:Point;
  <context> [ ];
  <cbd> [
    <a> [ <b> 2; <c> 5];
      <d> 42;
  ];
  <path> (<a> <b>);
  <a> [ <b> "Hello" ];
  <custom> [
    a js:MyCustomClass;
    js:value "VALUE";
  ].
`;

    const output = extractShapes(parseQuads(shape));

    const quads = parseQuads(data);
    const quad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;
    const obj = output.lenses[quad.object.value].execute({
      id: quad.subject,
      quads,
    });

    test("Shapes contain rdfl lenses", () => {
      const shapes = Object.keys(output.lenses);
      expect(shapes).toContain(RDFL.Context);
      expect(shapes).toContain(RDFL.CBD);
      expect(shapes).toContain(RDFL.PathLens);
    });

    test("Keys are present", () => {
      const keys = Object.keys(obj);
      expect(keys).toContain("path");
      expect(keys).toContain("cbd");
      expect(keys).toContain("context");
    });

    test("Context quads are found", () => {
      expect(obj.context.length).toEqual(quads.length);
    });

    test("Path applied to object works", () => {
      const result = obj.path.execute({ id: obj.id, quads: obj.context });
      expect(result[0].id.value).toEqual("Hello");
    });

    test("CBD works", () => {
      expect(obj.cbd.length).toBe(4);
    });

    test("Custom extract works", () => {
      expect(obj.custom.value).toBe("VALUE");
    });
  });
});

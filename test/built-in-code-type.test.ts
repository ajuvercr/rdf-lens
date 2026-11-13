import { afterEach, describe, expect, test, vi } from "vitest";
import { Parser } from "n3";
import type { Quad } from "@rdfjs/types";
import { RDF } from "@treecg/types";
import { BasicLens, Cont } from "../src/lens";
import { extractShapes } from "../src/shacl";

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdfl: <https://w3id.org/rdf-lens/ontology#> .
@prefix ex: <http://example.org/> .
`;

const parse = (turtle: string) => new Parser().parse(prefixes + turtle);

// A shape with one property "value" on ex:value, described by constraint
const shapeWith = (constraint: string) => `
[] a sh:NodeShape;
  sh:targetClass ex:Thing;
  sh:property [ sh:name "value"; sh:path ex:value; sh:maxCount 1; ${constraint} ].
`;

function extract(shapes: string, data: string): unknown {
    const quads = parse(shapes + data);
    const typeQuad = quads.find(
        (q) =>
            q.predicate.equals(RDF.terms.type) &&
            q.object.value === "http://example.org/Thing",
    )!;
    const object = <Record<string, unknown>>(
        extractShapes(quads).lenses[typeQuad.object.value].execute({
            id: typeQuad.subject,
            quads,
        })
    );
    return object.value;
}

function warningsOf(fn: () => unknown): string[] {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fn();
    return warn.mock.calls.map((x) => String(x[0]));
}

afterEach(() => {
    vi.restoreAllMocks();
});

describe("Built-in lenses through sh:codeType", () => {
    const data = `
ex:thing a ex:Thing;
  ex:value [ ex:name "a"; ex:nested [ ex:name "b" ] ].
`;

    test("rdfl:CBD hands over the quads of the value", () => {
        const quads = <Quad[]>(
            extract(
                shapeWith(
                    "sh:nodeKind sh:BlankNodeOrIRI; sh:codeType rdfl:CBD;",
                ),
                data,
            )
        );
        expect(quads.map((q) => q.object.value)).toEqual(
            expect.arrayContaining(["a", "b"]),
        );
        expect(quads).toHaveLength(3);
    });

    test("rdfl:Context hands over all quads", () => {
        const quads = <Quad[]>(
            extract(shapeWith("sh:codeType rdfl:Context;"), data)
        );
        expect(quads.length).toBeGreaterThan(3);
    });

    test("rdfl:PathLens reads a SHACL path into a lens", () => {
        const lens = <BasicLens<Cont, unknown>>(
            extract(
                shapeWith("sh:codeType rdfl:PathLens;"),
                "ex:thing a ex:Thing; ex:value ex:name.",
            )
        );
        expect(lens).toBeInstanceOf(BasicLens);
    });

    test("rdfl:TypedExtract uses the shape for the type of the value", () => {
        const shapes =
            shapeWith("sh:codeType rdfl:TypedExtract;") +
            `
[] a sh:NodeShape;
  sh:targetClass ex:Page;
  sh:property [ sh:name "size"; sh:path ex:size; sh:datatype xsd:integer; sh:maxCount 1 ].
`;
        expect(
            extract(
                shapes,
                "ex:thing a ex:Thing; ex:value [ a ex:Page; ex:size 10 ].",
            ),
        ).toEqual({ size: 10 });
    });

    test("the value is held to sh:nodeKind", () => {
        expect(() =>
            extract(
                shapeWith("sh:nodeKind sh:IRI; sh:codeType rdfl:CBD;"),
                data,
            ),
        ).toThrow(/Node kind violation/);
    });

    test("does not warn", () => {
        expect(
            warningsOf(() => extract(shapeWith("sh:codeType rdfl:CBD;"), data)),
        ).toEqual([]);
    });
});

describe("Built-in lenses through sh:class", () => {
    const data = 'ex:thing a ex:Thing; ex:value [ ex:name "a" ].';

    test("still work", () => {
        let quads: Quad[] = [];
        warningsOf(() => {
            quads = <Quad[]>extract(shapeWith("sh:class rdfl:CBD;"), data);
        });
        expect(quads).toHaveLength(1);
    });

    test("warn that sh:codeType replaces them", () => {
        const warnings = warningsOf(() =>
            extract(shapeWith("sh:class rdfl:CBD;"), data),
        );
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain("sh:class rdfl:CBD");
        expect(warnings[0]).toContain("use sh:codeType rdfl:CBD instead");
    });

    test("a class of its own does not warn", () => {
        const shapes =
            shapeWith("sh:class ex:Options;") +
            `
[] a sh:NodeShape;
  sh:targetClass ex:Options;
  sh:property [ sh:name "name"; sh:path ex:name; sh:datatype xsd:string; sh:maxCount 1 ].
`;
        expect(warningsOf(() => extract(shapes, data))).toEqual([]);
    });
});

import { describe, expect, test } from "vitest";
import { Parser } from "n3";
import { RDF } from "@treecg/types";
import { checkShapes } from "../src/check";
import { extractShapes } from "../src/shacl";

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix rdfl: <https://w3id.org/rdf-lens/ontology#> .
@prefix ex: <http://example.org/> .
`;

const parse = (turtle: string) => new Parser().parse(prefixes + turtle);

function extract(shapes: string, data: string): Record<string, unknown> {
    const quads = parse(shapes + data);
    const typeQuad = quads.find(
        (q) =>
            q.predicate.equals(RDF.terms.type) &&
            q.object.value === "http://example.org/Bucketizer",
    )!;
    return <Record<string, unknown>>(
        extractShapes(quads).lenses[typeQuad.object.value].execute({
            id: typeQuad.subject,
            quads,
        })
    );
}

// A bucketizer applies its strategies in order, so they are given as a list
const shapes = (constraint = "sh:minCount 1; sh:maxCount 1;") => `
[] a sh:NodeShape;
  sh:targetClass ex:Bucketizer;
  sh:property [
    sh:name "strategies";
    sh:path ex:strategy;
    sh:memberShape ex:StrategyShape;
    ${constraint}
  ].

ex:StrategyShape a sh:NodeShape;
  sh:property [
    sh:name "size";
    sh:path ex:size;
    sh:datatype xsd:integer;
    sh:maxCount 1;
  ].
`;

describe("sh:memberShape", () => {
    test("extracts the members of the list, in order", () => {
        expect(
            extract(
                shapes(),
                "ex:b a ex:Bucketizer; ex:strategy ( [ ex:size 3 ] [ ex:size 1 ] [ ex:size 2 ] ).",
            ),
        ).toEqual({ strategies: [{ size: 3 }, { size: 1 }, { size: 2 }] });
    });

    test("extracts the empty list as an empty array", () => {
        expect(
            extract(shapes(), "ex:b a ex:Bucketizer; ex:strategy ( ).")
                .strategies,
        ).toEqual([]);
    });

    test("gives an array of arrays for several lists", () => {
        expect(
            extract(
                shapes("sh:minCount 1;"),
                "ex:b a ex:Bucketizer; ex:strategy ( [ ex:size 1 ] ), ( [ ex:size 2 ] [ ex:size 3 ] ).",
            ).strategies,
        ).toEqual(
            expect.arrayContaining([[{ size: 1 }], [{ size: 2 }, { size: 3 }]]),
        );
    });

    test("rejects a value that is no list", () => {
        expect(() =>
            extract(
                shapes(),
                "ex:b a ex:Bucketizer; ex:strategy [ ex:size 1 ].",
            ),
        ).toThrow(/Expected an RDF list/);
    });

    test("uses the shape for the type of each member through rdfl:TypedExtract", () => {
        const typed = `
[] a sh:NodeShape;
  sh:targetClass ex:Bucketizer;
  sh:property [
    sh:name "strategies";
    sh:path ex:strategy;
    sh:memberShape ex:AnyStrategy;
    sh:maxCount 1;
  ].

ex:AnyStrategy a sh:NodeShape;
  sh:property [
    sh:name "config";
    sh:path ( );
    sh:codeType rdfl:TypedExtract;
    sh:maxCount 1;
  ].

[] a sh:NodeShape;
  sh:targetClass ex:Page;
  sh:property [ sh:name "pageSize"; sh:path ex:pageSize; sh:datatype xsd:integer; sh:maxCount 1 ].

[] a sh:NodeShape;
  sh:targetClass ex:Time;
  sh:property [ sh:name "path"; sh:path ex:path; sh:nodeKind sh:IRI; sh:codeType xsd:string; sh:maxCount 1 ].
`;
        expect(
            extract(
                typed,
                "ex:b a ex:Bucketizer; ex:strategy ( [ a ex:Page; ex:pageSize 10 ] [ a ex:Time; ex:path ex:at ] ).",
            ),
        ).toEqual({
            strategies: [
                { config: { pageSize: 10 } },
                { config: { path: "http://example.org/at" } },
            ],
        });
    });

    test("falls back to a default list", () => {
        expect(
            extract(
                shapes("sh:maxCount 1; sh:defaultValue ( [ ex:size 5 ] );"),
                "ex:b a ex:Bucketizer.",
            ),
        ).toEqual({ strategies: [{ size: 5 }] });
    });

    test("checkShapes reports a member shape that is not defined", () => {
        const report = checkShapes(
            parse(`
[] a sh:NodeShape;
  sh:targetClass ex:Bucketizer;
  sh:property [ sh:name "strategies"; sh:path ex:strategy; sh:memberShape ex:Missing ].
`),
        );
        expect(report.findings.map((x) => x.message)).toEqual([
            expect.stringContaining(
                "refers to the node shape <http://example.org/Missing>, which is not defined",
            ),
        ]);
    });
});

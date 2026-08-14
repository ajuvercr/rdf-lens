import { describe, expect, test } from "vitest";
import { Parser } from "n3";
import { RDF } from "@treecg/types";
import { extractShapes } from "../src/shacl";

const prefixes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix ex: <http://example.org/> .
@prefix rdfl: <https://w3id.org/rdf-lens/ontology#> .
`;

const parse = (turtle: string) => new Parser().parse(prefixes + turtle);

/**
 * Extracts the single typed subject of the data through the shape defined for
 * its rdf:type, the way a consumer of extractShapes would.
 */
function extract(shapes: string, data: string): Record<string, unknown> {
    const output = extractShapes(parse(shapes));
    const quads = parse(data);
    const typeQuad = quads.find((x) => x.predicate.equals(RDF.terms.type))!;

    return <Record<string, unknown>>output.lenses[
        typeQuad.object.value
    ].execute({
        id: typeQuad.subject,
        quads,
    });
}

describe("sh:defaultValue", () => {
    const meShape = `
[] a sh:NodeShape;
  sh:targetClass ex:Me;
  sh:property [
    sh:name "name";
    sh:path ex:name;
    sh:minCount 1;
    sh:maxCount 1;
    sh:datatype xsd:string;
    sh:defaultValue "ajuvercr";
  ], [
    sh:name "age";
    sh:path ex:age;
    sh:minCount 1;
    sh:maxCount 1;
    sh:datatype xsd:integer;
  ].
`;

    test("Missing value falls back to the default", () => {
        const object = extract(
            meShape,
            `
<foobar> a ex:Me;
  ex:age 95.
`,
        );

        expect(object).toEqual({ name: "ajuvercr", age: 95 });
    });

    test("Present value wins over the default", () => {
        const object = extract(
            meShape,
            `
<foobar> a ex:Me;
  ex:name "semssie";
  ex:age 95.
`,
        );

        expect(object).toEqual({ name: "semssie", age: 95 });
    });

    test("Default is converted with the declared datatype", () => {
        const object = extract(
            `
[] a sh:NodeShape;
  sh:targetClass ex:Me;
  sh:property [
    sh:name "age";
    sh:path ex:age;
    sh:maxCount 1;
    sh:datatype xsd:integer;
    sh:defaultValue 42;
  ], [
    sh:name "member";
    sh:path ex:member;
    sh:maxCount 1;
    sh:datatype xsd:boolean;
    sh:defaultValue "true";
  ].
`,
            "<foobar> a ex:Me.",
        );

        expect(object).toEqual({ age: 42, member: true });
    });

    test("A missing value without a default is still an error when required", () => {
        expect(() =>
            extract(
                meShape,
                `
<foobar> a ex:Me.
`,
            ),
        ).toThrow();
    });

    test("Default may be an environment variable", () => {
        process.env["RDF_LENS_TEST_NAME"] = "from the environment";

        const object = extract(
            `
[] a sh:NodeShape;
  sh:targetClass ex:Me;
  sh:property [
    sh:name "name";
    sh:path ex:name;
    sh:maxCount 1;
    sh:datatype xsd:string;
    sh:defaultValue [
      a rdfl:EnvVariable;
      rdfl:envKey "RDF_LENS_TEST_NAME";
      rdfl:envDefault "unset";
    ];
  ].
`,
            "<foobar> a ex:Me.",
        );

        expect(object).toEqual({ name: "from the environment" });
    });

    describe("nested shapes", () => {
        const friendShape = (defaultValue: string) => `
${meShape}

[] a sh:NodeShape;
  sh:targetClass ex:Friend;
  sh:property [
    sh:name "friend";
    sh:path ex:friend;
    sh:class ex:Me;
    sh:minCount 1;
    sh:maxCount 1;
    sh:defaultValue ${defaultValue};
  ].
`;

        test("Default node is extracted through the class shape", () => {
            const object = extract(
                friendShape("[ a ex:Me; ex:age 95 ]"),
                "<foobar> a ex:Friend.",
            );

            expect(object).toEqual({
                friend: { name: "ajuvercr", age: 95 },
            });
        });

        test("Default node does not need an rdf:type", () => {
            const object = extract(
                friendShape("[ ex:age 95 ]"),
                "<foobar> a ex:Friend.",
            );

            expect(object).toEqual({
                friend: { name: "ajuvercr", age: 95 },
            });
        });

        test("Properties of the default node win over the nested defaults", () => {
            const object = extract(
                friendShape(`
[ ex:name "semssie"; ex:age 94 ]
`),
                "<foobar> a ex:Friend.",
            );

            expect(object).toEqual({
                friend: { name: "semssie", age: 94 },
            });
        });

        test("Defaults apply inside a node that is present in the data", () => {
            const object = extract(
                friendShape("[ ex:age 95 ]"),
                `
<foobar> a ex:Friend;
  ex:friend [
    ex:age 95;
  ].
`,
            );

            expect(object).toEqual({
                friend: { name: "ajuvercr", age: 95 },
            });
        });
    });

    describe("multi valued fields", () => {
        const listShape = (defaultValue: string) => `
[] a sh:NodeShape;
  sh:targetClass ex:Me;
  sh:property [
    sh:name "nicknames";
    sh:path ex:nickname;
    sh:datatype xsd:string;
    sh:defaultValue ${defaultValue};
  ].
`;

        test("Empty field falls back to a single default", () => {
            const object = extract(
                listShape(`
"ajuvercr"
`),
                "<foobar> a ex:Me.",
            );

            expect(object).toEqual({ nicknames: ["ajuvercr"] });
        });

        test("Empty field falls back to a default rdf list", () => {
            const object = extract(
                listShape(`
( "ajuvercr" "semssie" )
`),
                "<foobar> a ex:Me.",
            );

            expect(object).toEqual({ nicknames: ["ajuvercr", "semssie"] });
        });

        test("Values in the data suppress the default entirely", () => {
            const object = extract(
                listShape(`
( "ajuvercr" "semssie" )
`),
                `
<foobar> a ex:Me;
  ex:nickname "arthur".
`,
            );

            expect(object).toEqual({ nicknames: ["arthur"] });
        });
    });
});

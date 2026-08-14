import { describe, expect, test } from "vitest";
import { Parser } from "n3";
import { extractShapes } from "../src/shacl";

const PREFIXES = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix vault: <https://mdld.js.org/vault/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
`;

function shapesOf(turtle: string) {
    return extractShapes(new Parser().parse(PREFIXES + turtle));
}

describe("Property shape extraction", () => {
    test("Property shape referenced by IRI", () => {
        const output = shapesOf(`
vault:AgentShape a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:property vault:AgentHandle .

vault:AgentHandle a sh:PropertyShape ;
    sh:name "handle" ;
    sh:path vault:handle ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .
`);

        expect(output.shapes.length).toBe(1);
        expect(output.shapes[0].fields.map((f) => f.name)).toEqual(["handle"]);
    });

    test("Multiple property shapes referenced by IRI", () => {
        const output = shapesOf(`
vault:AgentShape a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:property vault:AgentHandle ;
    sh:property vault:AgentAuthority .

vault:AgentHandle a sh:PropertyShape ;
    sh:name "handle" ;
    sh:path vault:handle ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .

vault:AgentAuthority a sh:PropertyShape ;
    sh:name "authority" ;
    sh:path vault:authority ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .
`);

        expect(output.shapes.length).toBe(1);
        expect(output.shapes[0].fields.map((f) => f.name).sort()).toEqual([
            "authority",
            "handle",
        ]);
    });

    test("Multiple property shapes defined inline as blank nodes", () => {
        const output = shapesOf(`
vault:AgentShape a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:property [
        sh:name "handle" ;
        sh:path vault:handle ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:string
    ] ;
    sh:property [
        sh:name "authority" ;
        sh:path vault:authority ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:string
    ] .
`);

        expect(output.shapes.length).toBe(1);
        expect(output.shapes[0].fields.map((f) => f.name).sort()).toEqual([
            "authority",
            "handle",
        ]);
    });

    // A property shape without sh:datatype and without sh:class has no way to
    // extract a value. That property is dropped, but it used to take the whole
    // node shape with it, leaving no shapes at all.
    test("Property without sh:datatype or sh:class only drops that field", () => {
        const output = shapesOf(`
vault:AgentShape a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:property vault:AgentHandle ;
    sh:property vault:AgentAuthority .

vault:AgentHandle a sh:PropertyShape ;
    sh:name "handle" ;
    sh:path vault:handle ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .

vault:AgentAuthority a sh:PropertyShape ;
    sh:name "authority" ;
    sh:path vault:authority ;
    sh:minCount 1 ;
    sh:maxCount 1 .
`);

        expect(output.shapes.length).toBe(1);
        expect(output.shapes[0].fields.map((f) => f.name)).toEqual(["handle"]);
        // Every surviving field is usable, none of them lack an extract lens
        for (const field of output.shapes[0].fields) {
            expect(field.extract).toBeDefined();
            expect(field.path).toBeDefined();
        }
    });

    test("Complex shape with only named property shapes", () => {
        const output = shapesOf(`
vault:PersonShape a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:description "A person with multiple properties" ;
    sh:property vault:PersonName ;
    sh:property vault:PersonEmail ;
    sh:property vault:PersonHomepage ;
    sh:property vault:PersonKnows .

vault:PersonName a sh:PropertyShape ;
    sh:name "name" ;
    sh:path foaf:name ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .

vault:PersonEmail a sh:PropertyShape ;
    sh:name "email" ;
    sh:path foaf:mbox ;
    sh:minCount 0 ;
    sh:maxCount 1 ;
    sh:datatype xsd:anyURI .

vault:PersonHomepage a sh:PropertyShape ;
    sh:name "homepage" ;
    sh:path foaf:homepage ;
    sh:minCount 0 ;
    sh:maxCount 1 ;
    sh:datatype xsd:anyURI .

vault:PersonKnows a sh:PropertyShape ;
    sh:name "knows" ;
    sh:path foaf:knows ;
    sh:minCount 0 ;
    sh:maxCount 100 ;
    sh:class prov:Agent .
`);

        expect(output.shapes.length).toBe(1);
        expect(output.shapes[0].description).toBe(
            "A person with multiple properties",
        );
        expect(output.shapes[0].fields.map((f) => f.name).sort()).toEqual([
            "email",
            "homepage",
            "knows",
            "name",
        ]);
    });
});

import { describe, expect, test } from "vitest";
import { Parser } from "n3";
import { extractShapes } from "../src/shacl";

describe("Multi-property IRI-referenced shapes", () => {
    test("Single-property shape with IRI reference works", () => {
        const shapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix vault: <https://mdld.js.org/vault/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<https://mdld.js.org/vault/prov/AgentShape> a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:property <https://mdld.js.org/vault/prov/AgentHandle> .

<https://mdld.js.org/vault/prov/AgentHandle> a sh:PropertyShape ;
    sh:name "handle" ;
    sh:path <https://mdld.js.org/vault/handle> ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .
`;
        const quads = new Parser().parse(shapes);
        const output = extractShapes(quads);

        console.log("Single-property shapes:", output.shapes);
        console.log("Single-property lenses:", Object.keys(output.lenses));

        expect(output.shapes.length).toBeGreaterThan(0);
        expect(output.shapes[0].fields.length).toBe(1);
    });

    test("Multi-property shape with IRI references fails (current bug)", () => {
        const shapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix vault: <https://mdld.js.org/vault/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<https://mdld.js.org/vault/prov/AgentShape> a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:property <https://mdld.js.org/vault/prov/AgentHandle> ;
    sh:property <https://mdld.js.org/vault/prov/AgentAuthority> .

<https://mdld.js.org/vault/prov/AgentHandle> a sh:PropertyShape ;
    sh:name "handle" ;
    sh:path <https://mdld.js.org/vault/handle> ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .

<https://mdld.js.org/vault/prov/AgentAuthority> a sh:PropertyShape ;
    sh:name "authority" ;
    sh:path <https://mdld.js.org/vault/authority> ;
    sh:minCount 1 ;
    sh:maxCount 1 .
`;
        const quads = new Parser().parse(shapes);
        const output = extractShapes(quads);

        console.log("Multi-property shapes:", output.shapes);
        console.log("Multi-property lenses:", Object.keys(output.lenses));

        // This should pass but currently fails
        expect(output.shapes.length).toBeGreaterThan(0);
        expect(output.shapes[0].fields.length).toBe(2);
    });

    test("Multi-property shape with inline blank nodes works", () => {
        const shapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix vault: <https://mdld.js.org/vault/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

<https://mdld.js.org/vault/prov/AgentShape> a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:property [
        sh:name "handle" ;
        sh:path <https://mdld.js.org/vault/handle> ;
        sh:minCount 1 ;
        sh:maxCount 1 ;
        sh:datatype xsd:string 
    ] ;
    sh:property [
        sh:name "authority" ;
        sh:path <https://mdld.js.org/vault/authority> ;
        sh:minCount 1 ;
        sh:maxCount 1 
    ] .
`;
        const quads = new Parser().parse(shapes);
        const output = extractShapes(quads);

        console.log("Inline multi-property shapes:", output.shapes);
        console.log(
            "Inline multi-property lenses:",
            Object.keys(output.lenses),
        );

        expect(output.shapes.length).toBeGreaterThan(0);
        expect(output.shapes[0].fields.length).toBe(2);
    });

    test("Complex multi-property shape with only named nodes (no blank nodes)", () => {
        const shapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix vault: <https://mdld.js.org/vault/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .

<https://mdld.js.org/vault/prov/PersonShape> a sh:NodeShape ;
    sh:targetClass prov:Agent ;
    sh:description "A person with multiple properties" ;
    sh:property <https://mdld.js.org/vault/prov/PersonName> ;
    sh:property <https://mdld.js.org/vault/prov/PersonEmail> ;
    sh:property <https://mdld.js.org/vault/prov/PersonHomepage> ;
    sh:property <https://mdld.js.org/vault/prov/PersonKnows> .

<https://mdld.js.org/vault/prov/PersonName> a sh:PropertyShape ;
    sh:name "name" ;
    sh:path foaf:name ;
    sh:minCount 1 ;
    sh:maxCount 1 ;
    sh:datatype xsd:string .

<https://mdld.js.org/vault/prov/PersonEmail> a sh:PropertyShape ;
    sh:name "email" ;
    sh:path foaf:mbox ;
    sh:minCount 0 ;
    sh:maxCount 1 ;
    sh:datatype xsd:anyURI .

<https://mdld.js.org/vault/prov/PersonHomepage> a sh:PropertyShape ;
    sh:name "homepage" ;
    sh:path foaf:homepage ;
    sh:minCount 0 ;
    sh:maxCount 1 ;
    sh:datatype xsd:anyURI .

<https://mdld.js.org/vault/prov/PersonKnows> a sh:PropertyShape ;
    sh:name "knows" ;
    sh:path foaf:knows ;
    sh:minCount 0 ;
    sh:maxCount 100 ;
    sh:class prov:Agent .
`;
        const quads = new Parser().parse(shapes);
        const output = extractShapes(quads);

        console.log("Complex multi-property shapes:", output.shapes);
        console.log(
            "Complex multi-property lenses:",
            Object.keys(output.lenses),
        );

        expect(output.shapes.length).toBeGreaterThan(0);
        expect(output.shapes[0].fields.length).toBe(4);

        // Verify each property was extracted with correct details
        const nameField = output.shapes[0].fields.find(
            (f: { name: string }) => f.name === "name",
        );
        expect(nameField).toBeDefined();

        const emailField = output.shapes[0].fields.find(
            (f: { name: string }) => f.name === "email",
        );
        expect(emailField).toBeDefined();

        const homepageField = output.shapes[0].fields.find(
            (f: { name: string }) => f.name === "homepage",
        );
        expect(homepageField).toBeDefined();

        const knowsField = output.shapes[0].fields.find(
            (f: { name: string }) => f.name === "knows",
        );
        expect(knowsField).toBeDefined();
    });
});

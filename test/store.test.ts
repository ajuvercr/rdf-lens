import { describe, expect, test } from "vitest";
import { Parser, Store } from "n3";
import { DataFactory } from "rdf-data-factory";
import {
    createContext,
    invPred,
    match,
    pred,
    subject,
    subjects,
    unique,
    QuadStore,
} from "../src";
import { CBDLens, extractShapes } from "../src/shacl";

const { namedNode } = new DataFactory();

const data = `
@prefix ex: <http://example.org/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .

ex:alice a ex:Person ;
    foaf:name "Alice" ;
    foaf:knows ex:bob, ex:carol ;
    ex:address [ ex:street "Main street" ; ex:city "Ghent" ] .

ex:bob a ex:Person ;
    foaf:name "Bob" ;
    foaf:knows ex:alice .

ex:carol a ex:Person ;
    foaf:name "Carol" .
`;

const quads = new Parser().parse(data);
const store: QuadStore = new Store(quads);

const alice = namedNode("http://example.org/alice");
const knows = namedNode("http://xmlns.com/foaf/0.1/knows");
const type = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const person = namedNode("http://example.org/Person");

// The store and the array must be interchangeable, so compare the two paths on
// the identity of the terms they return rather than on quad order.
function ids(conts: { id: { value: string } }[]): string[] {
    return conts.map((x) => x.id.value).sort();
}

describe("n3.Store as a drop-in for Quad[]", () => {
    test("n3.Store satisfies QuadStore without casting", () => {
        // Compile time assertion, the assignment above is the actual test
        expect(typeof store.getQuads).toBe("function");
    });

    test("pred agrees with the array path", () => {
        const lens = pred(knows);
        expect(
            ids(lens.execute({ id: alice, quads }, createContext())),
        ).toEqual(
            ids(lens.execute({ id: alice, quads: store }, createContext())),
        );
    });

    test("pred without a predicate agrees with the array path", () => {
        const lens = pred();
        expect(
            ids(lens.execute({ id: alice, quads }, createContext())),
        ).toEqual(
            ids(lens.execute({ id: alice, quads: store }, createContext())),
        );
    });

    test("invPred agrees with the array path", () => {
        const lens = invPred(knows);
        expect(
            ids(lens.execute({ id: alice, quads }, createContext())),
        ).toEqual(
            ids(lens.execute({ id: alice, quads: store }, createContext())),
        );
    });

    test("match agrees with the array path", () => {
        const lens = match(undefined, type, person).thenAll(subject);
        expect(ids(lens.execute(quads, createContext()))).toEqual(
            ids(lens.execute(store, createContext())),
        );
    });

    test("subjects agrees with the array path", () => {
        const lens = subjects().then(unique()).asMulti();
        expect(ids(lens.execute(quads, createContext()))).toEqual(
            ids(lens.execute(store, createContext())),
        );
    });

    test("CBD traverses blank nodes in both paths", () => {
        const fromArray = CBDLens.execute(
            { id: alice, quads },
            createContext(),
        );
        const fromStore = CBDLens.execute(
            { id: alice, quads: store },
            createContext(),
        );

        expect(fromStore.length).toBe(fromArray.length);
        // The blank node address is followed, not just alice's own quads
        expect(fromArray.some((q) => q.object.value === "Main street")).toBe(
            true,
        );
        expect(fromStore.some((q) => q.object.value === "Main street")).toBe(
            true,
        );
    });

    test("extracting through a shape yields the same result from a store", () => {
        const shape = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix ex: <http://example.org/> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .

[ ] a sh:NodeShape ;
    sh:targetClass ex:Person ;
    sh:property [
        sh:name "name" ;
        sh:path foaf:name ;
        sh:maxCount 1 ;
        sh:datatype xsd:string
    ] ;
    sh:property [
        sh:name "knows" ;
        sh:path foaf:knows ;
        sh:datatype xsd:iri
    ] .
`;
        const output = extractShapes(new Parser().parse(shape));
        const lens = output.lenses["http://example.org/Person"];

        expect(
            lens.execute({ id: alice, quads: store }, createContext()),
        ).toEqual(lens.execute({ id: alice, quads }, createContext()));
    });
});

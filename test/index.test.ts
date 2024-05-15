import { describe, expect, test } from "vitest";
import { DataFactory, Parser } from "n3";
import { pred } from "../src/index";
const { namedNode, literal } = DataFactory;

const tyPred = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");

const quadsLiteral = `
  <s1> a <sometype>;
    <p1> <o1>.

  <sometype> <p2> "42".

  <person> <age> 32;
    <name> "John".
`;

const quads = new Parser().parse(quadsLiteral);
// const store = new Store(quads);

describe("ETL", () => {
    test("simple extract works", () => {
        const res = pred(tyPred)
            .one()
            .execute({ id: namedNode("s1"), quads });
        expect(res.id.equals(namedNode("sometype"))).toBeTruthy();
    });

    test("dense extract works", () => {
        const res = pred(tyPred)
            .one()
            .then(pred(namedNode("p2")).one())
            .execute({ id: namedNode("s1"), quads });
        expect(res.id.equals(literal("42"))).toBeTruthy();
    });

    test("simple extract and map works", () => {
        const res = pred(tyPred)
            .one()
            .then(pred(namedNode("p2")).one())
            .map((x) => +x.id.value)
            .execute({ id: namedNode("s1"), quads });
        expect(res).toBe(42);
    });

    test("combined extract to dict", () => {
        const name = pred(namedNode("name"))
            .one()
            .map((x) => ({
                name: x.id.value,
            }));
        const age = pred(namedNode("age"))
            .one()
            .map((x) => ({ age: +x.id.value }));
        const age2 = pred(namedNode("age2"))
            .one(undefined)
            .map((x) => ({
                age2: x?.id.value,
            }));

        const person = name.and(age, age2).map((xs) => Object.assign(...xs));

        const p = person.execute({ id: namedNode("person"), quads });
        expect(p.name).toEqual("John");
        expect(p.age).toEqual(32);
    });
});

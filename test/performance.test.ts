import { describe, test, expect } from "vitest";
import { DataFactory } from "rdf-data-factory";
import { Parser, Store } from "n3";
import {
    match,
    subject,
    unique,
    createContext,
    pred,
    Quads,
    QuadStore,
} from "../src";

const { namedNode } = new DataFactory();

// 500 entities, each with 50 properties and 50 relations: ~50K quads
function generateQuads() {
    const entities = 500;
    const propertiesPerEntity = 50;
    const relatedEntitiesPerEntity = 50;
    let turtle = "";

    for (let i = 0; i < entities; i++) {
        const subject = `http://example.org/entity${i}`;
        const type = `http://example.org/Type${i % 3}`;

        turtle += `<${subject}> a <${type}>;\n`;

        for (let j = 0; j < propertiesPerEntity; j++) {
            const predicate = `http://example.org/prop${j}`;
            const object = `http://example.org/value${i}_${j}`;
            const end = j < propertiesPerEntity - 1 ? ";" : ".";
            turtle += `  <${predicate}> <${object}>${end}\n`;
        }

        for (let k = 0; k < relatedEntitiesPerEntity; k++) {
            const relatedId = (i + k + 1) % entities;
            const related = `http://example.org/entity${relatedId}`;
            const relPredicate = `http://example.org/related${k % 10}`;
            turtle += `<${subject}> <${relPredicate}> <${related}>.\n`;
        }
    }

    return new Parser().parse(turtle);
}

const quads = generateQuads();
const store: QuadStore = new Store(quads);

const rdfType = namedNode("http://www.w3.org/1999/02/22-rdf-syntax-ns#type");
const targetType = namedNode("http://example.org/Type0");
const entity0 = namedNode("http://example.org/entity0");

function time(fn: () => unknown): number {
    const start = performance.now();
    fn();
    return performance.now() - start;
}

/**
 * Runs the same query over the quad array and over the indexed store, asserts
 * both return the same terms, and reports how much the indexes helped.
 */
function compare(name: string, run: (input: Quads) => string[]): number {
    const fromArray = run(quads);
    const fromStore = run(store);

    expect(fromArray.length).toBeGreaterThan(0);
    expect(fromStore).toEqual(fromArray);

    const arrayTime = time(() => run(quads));
    const storeTime = time(() => run(store));
    const speedup = arrayTime / storeTime;

    console.log(
        `${name}: array ${arrayTime.toFixed(2)}ms, ` +
            `store ${storeTime.toFixed(2)}ms (${speedup.toFixed(1)}x)`,
    );

    return speedup;
}

const ids = (conts: { id: { value: string } }[]) =>
    conts.map((x) => x.id.value).sort();

describe("Quad[] versus indexed store", () => {
    const entitiesOfType = match(undefined, rdfType, targetType)
        .thenAll(subject)
        .then(unique())
        .asMulti();

    test("match by type", () => {
        const speedup = compare("match by type", (input) =>
            ids(entitiesOfType.execute(input, createContext())),
        );

        expect(speedup).toBeGreaterThan(1);
    });

    test("multi hop navigation", () => {
        const lens = pred(namedNode("http://example.org/related0"))
            .thenFlat(pred(namedNode("http://example.org/related1")))
            .thenFlat(pred(namedNode("http://example.org/prop0")));

        const speedup = compare("multi hop", (input) =>
            ids(lens.execute({ id: entity0, quads: input }, createContext())),
        );

        expect(speedup).toBeGreaterThan(1);
    });

    test("filtered multi step query", () => {
        const related0 = namedNode("http://example.org/related0");

        const speedup = compare("filtered query", (input) => {
            const entities = entitiesOfType.execute(input, createContext());
            return ids(
                entities.filter(
                    ({ id }) =>
                        pred(related0).execute(
                            { id, quads: input },
                            createContext(),
                        ).length > 0,
                ),
            );
        });

        expect(speedup).toBeGreaterThan(1);
    });
});

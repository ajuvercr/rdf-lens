import { describe, test, expect } from "vitest";
import { DataFactory } from "rdf-data-factory";
import { Parser, Store } from "n3";
import { match, subject, unique, createContext, pred, QuadStore } from "../src";

const { namedNode } = new DataFactory();

// Generate 100K quads: 1000 entities × 100 properties each
function generateQuads(_count: number = 100000) {
    const entitiesPerType = 500;
    const propertiesPerEntity = 50;
    const relatedEntitiesPerEntity = 50;
    let turtle = "";

    for (let i = 0; i < entitiesPerType; i++) {
        const subject = `http://example.org/entity${i}`;
        const type = `http://example.org/Type${i % 3}`;

        turtle += `<${subject}> a <${type}>;\n`;

        // Direct properties
        for (let j = 0; j < propertiesPerEntity; j++) {
            const predicate = `http://example.org/prop${j}`;
            const object = `http://example.org/value${i}_${j}`;
            turtle += `  <${predicate}> <${object}>${j < propertiesPerEntity - 1 ? ";" : "."}\n`;
        }

        // Related entities (multi-hop relationships)
        for (let k = 0; k < relatedEntitiesPerEntity; k++) {
            const relatedId = (i + k + 1) % entitiesPerType;
            const related = `http://example.org/entity${relatedId}`;
            const relPredicate = `http://example.org/related${k % 10}`;
            turtle += `<${subject}> <${relPredicate}> <${related}>.\n`;
        }
    }

    return new Parser().parse(turtle);
}

describe("Performance: Baseline vs N3 Store", () => {
    const quads = generateQuads(100000);
    const targetType = namedNode("http://example.org/Type0");
    const rdfType = namedNode(
        "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
    );
    const _predicate = namedNode("http://example.org/prop50");

    test("Baseline: Linear scanning (no store)", () => {
        const start = performance.now();

        const entities = match(undefined, rdfType, targetType)
            .thenAll(subject)
            .then(unique())
            .execute(quads, createContext());

        const baselineTime = performance.now() - start;

        expect(entities.length).toBeGreaterThan(0);
        console.log(`Baseline (linear scan): ${baselineTime.toFixed(2)}ms`);
    });

    test("N3 Store: Indexed lookups", () => {
        const store = new Store();
        store.addQuads(quads);

        const start = performance.now();

        const results = store.getQuads(null, rdfType, targetType, null);
        const subjects = [...new Set(results.map((q) => q.subject))];

        const n3Time = performance.now() - start;

        expect(subjects.length).toBeGreaterThan(0);
        console.log(`N3 Store (indexed): ${n3Time.toFixed(2)}ms`);
    });

    test("QuadStore interface with N3", () => {
        const store = new Store();
        store.addQuads(quads);

        // Pass store directly to match() (new signature accepts Quad[] | QuadStore)
        const start = performance.now();

        const results = match(undefined, rdfType, targetType).execute(
            store as unknown as QuadStore,
            createContext(),
        );

        const quadStoreTime = performance.now() - start;

        expect(results.length).toBeGreaterThan(0);
        console.log(`QuadStore interface: ${quadStoreTime.toFixed(2)}ms`);
    });

    test("Performance comparison", () => {
        const store = new Store();
        store.addQuads(quads);

        // Baseline
        const baselineStart = performance.now();
        match(undefined, rdfType, targetType)
            .thenAll(subject)
            .then(unique())
            .execute(quads, createContext());
        const baselineTime = performance.now() - baselineStart;

        // N3 Store
        const n3Start = performance.now();
        store.getQuads(null, rdfType, targetType, null);
        const n3Time = performance.now() - n3Start;

        const speedup = baselineTime / n3Time;

        console.log("\nPerformance Summary:");
        console.log(`  Baseline: ${baselineTime.toFixed(2)}ms`);
        console.log(`  N3 Store: ${n3Time.toFixed(2)}ms`);
        console.log(`  Speedup: ${speedup.toFixed(2)}x`);

        expect(speedup).toBeGreaterThan(1);
    });

    test("Complex: Multi-hop navigation (baseline)", () => {
        const start = performance.now();

        const results = pred(namedNode("http://example.org/related0"))
            .thenFlat(pred(namedNode("http://example.org/related1")))
            .thenFlat(pred(namedNode("http://example.org/prop0")))
            .execute(
                { id: namedNode("http://example.org/entity0"), quads },
                createContext(),
            );

        const baselineTime = performance.now() - start;

        expect(results.length).toBeGreaterThan(0);
        console.log(`Multi-hop (baseline): ${baselineTime.toFixed(2)}ms`);
    });

    test("Complex: Multi-hop navigation (N3 Store)", () => {
        const store = new Store();
        store.addQuads(quads);

        const containers = [
            { id: namedNode("http://example.org/entity0"), quads, store },
        ];

        const start = performance.now();

        const results = containers
            .map(({ id, store }) =>
                store!.getQuads(
                    id,
                    namedNode("http://example.org/related0"),
                    null,
                    null,
                ),
            )
            .flatMap(() =>
                store!.getQuads(
                    namedNode("http://example.org/entity1"),
                    namedNode("http://example.org/related1"),
                    null,
                    null,
                ),
            )
            .flatMap(() =>
                store!.getQuads(
                    namedNode("http://example.org/entity2"),
                    namedNode("http://example.org/prop0"),
                    null,
                    null,
                ),
            );

        const n3Time = performance.now() - start;

        expect(results.length).toBeGreaterThan(0);
        console.log(`Multi-hop (N3 Store): ${n3Time.toFixed(2)}ms`);
    });

    test("Complex: Related entities traversal (baseline)", () => {
        const start = performance.now();

        const results = pred(namedNode("http://example.org/related0")).execute(
            { id: namedNode("http://example.org/entity0"), quads },
            createContext(),
        );

        const baselineTime = performance.now() - start;

        expect(results.length).toBeGreaterThan(0);
        console.log(
            `Related entities (baseline): ${baselineTime.toFixed(2)}ms`,
        );
    });

    test("Complex: Related entities traversal (N3 Store)", () => {
        const store = new Store();
        store.addQuads(quads);

        const start = performance.now();

        const results = store.getQuads(
            namedNode("http://example.org/entity0"),
            namedNode("http://example.org/related0"),
            null,
            null,
        );

        const n3Time = performance.now() - start;

        expect(results.length).toBeGreaterThan(0);
        console.log(`Related entities (N3 Store): ${n3Time.toFixed(2)}ms`);
    });

    test("Complex: Filtered multi-step query (baseline)", () => {
        const start = performance.now();

        const entities = match(undefined, rdfType, targetType)
            .thenAll(subject)
            .then(unique())
            .execute(quads, createContext());

        const filtered = entities.filter(({ id }) => {
            const related = pred(
                namedNode("http://example.org/related0"),
            ).execute({ id, quads }, createContext());
            return related.length > 0;
        });

        const baselineTime = performance.now() - start;

        expect(filtered.length).toBeGreaterThan(0);
        console.log(`Filtered query (baseline): ${baselineTime.toFixed(2)}ms`);
    });

    test("Complex: Filtered multi-step query (N3 Store)", () => {
        const store = new Store();
        store.addQuads(quads);

        const start = performance.now();

        const typeQuads = store.getQuads(null, rdfType, targetType, null);
        const subjects = [...new Set(typeQuads.map((q) => q.subject))];

        const filtered = subjects.filter((subject) => {
            const related = store.getQuads(
                subject,
                namedNode("http://example.org/related0"),
                null,
                null,
            );
            return related.length > 0;
        });

        const n3Time = performance.now() - start;

        expect(filtered.length).toBeGreaterThan(0);
        console.log(`Filtered query (N3 Store): ${n3Time.toFixed(2)}ms`);
    });
});

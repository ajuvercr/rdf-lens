import { expect, test, describe } from "vitest";
import { extractProcessors, extractSteps, Source } from "@ajuvercr/js-runner";

const pipeline = `
        @prefix js: <https://w3id.org/conn/js#>.
        @prefix ws: <https://w3id.org/conn/ws#>.
        @prefix : <https://w3id.org/conn#>.
        @prefix owl: <http://www.w3.org/2002/07/owl#>.
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#>.
        @prefix xsd: <http://www.w3.org/2001/XMLSchema#>.
        @prefix sh: <http://www.w3.org/ns/shacl#>.

        <> owl:imports <./node_modules/@ajuvercr/js-runner/ontology.ttl>, <./processors.ttl>.

        <incoming> a js:JsReaderChannel.
        <outgoing> a js:JsWriterChannel.

        [ ] a js:Log;
            js:incoming <incoming>;
            js:outgoing <outgoing>.
    `;

describe("processor", () => {
    test("definition", async () => {
        expect.assertions(5);

        const source: Source = {
            value: pipeline,
            baseIRI: process.cwd() + "/config.ttl",
            type: "memory",
        };

        // Parse pipeline into processors.
        const {
            processors,
            quads,
            shapes: config,
        } = await extractProcessors(source);

        // Extract the Log processor.
        const env = processors.find((x) => x.ty.value.endsWith("Log"))!;
        expect(env).toBeDefined();

        const args = extractSteps(env, quads, config);
        expect(args.length).toBe(1);
        expect(args[0].length).toBe(2);

        const [[incoming, outgoing]] = args;
        expect(incoming.ty.id).toBe("https://w3id.org/conn/js#JsReaderChannel");
        expect(outgoing.ty.id).toBe("https://w3id.org/conn/js#JsWriterChannel");
    });
});

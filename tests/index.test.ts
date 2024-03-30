import { log } from "../src";
import { SimpleStream } from "@ajuvercr/js-runner";
import { expect, describe, test, vi } from "vitest";

describe("log", () => {
    test("successful", async () => {
        const consoleLog = vi.spyOn(console, "log");
        expect.assertions(7);

        const incoming = new SimpleStream<string>();
        const outgoing = new SimpleStream<string>();

        // We expect each one of the messages to have been logged.
        outgoing.on("end", () => {
            const calls = consoleLog.mock.calls;
            expect(calls).toHaveLength(3);
            expect(calls[0][0]).toBe("Hello, World!");
            expect(calls[1][0]).toBe("This is a second message");
            expect(calls[2][0]).toBe("Goodbye.");
        });

        let index = 0;
        outgoing.on("data", (data) => {
            if (index == 0) {
                expect(data).toBe("Hello, World!");
            } else if (index == 1) {
                expect(data).toBe("This is a second message");
            } else {
                expect(data).toBe("Goodbye.");
            }
            index += 1;
        });

        // Initialize the processor.
        const startLogging = log(incoming, outgoing);
        await startLogging();

        // Push all messages into the pipeline.
        await incoming.push("Hello, World!");
        await incoming.push("This is a second message");
        await incoming.push("Goodbye.");

        await incoming.end();
        consoleLog.mockRestore();
    });
});

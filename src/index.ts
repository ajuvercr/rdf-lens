import { Stream, Writer } from "@treecg/connector-types";

export function log(
    incoming: Stream<string>,
    outgoing: Writer<string>,
): () => Promise<void> {
    return async () => {
        incoming.on("data", (data) => {
            console.log(data);
            outgoing.push(data);
        });

        incoming.on("end", () => {
            outgoing.end();
        });
    };
}

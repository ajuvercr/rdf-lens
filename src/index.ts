import { Stream, Writer } from "@treecg/connector-types";

/**
 * The logging function is a very simple processor which simply logs the
 * incoming stream to the console and pipes it directly into the outgoing
 * stream.
 *
 * @param incoming The data stream which must be logged.
 * @param outgoing The data stream into which the incoming stream is written.
 */
export function log(
    incoming: Stream<string>,
    outgoing: Writer<string>,
): () => Promise<void> {
    /**************************************************************************
     * This is where you set up your processor. This includes reading         *
     * configuration files, initializing class instances, etc. You are        *
     * guaranteed that no data will flow in the pipeline as long as your      *
     * processor function has not returned here.                              *
     *                                                                        *
     * You must therefore initialize the data handlers, but you may not push  *
     * any data into the pipeline here.                                       *
     **************************************************************************/

    incoming.on("data", (data) => {
        outgoing
            .push(data) // Push data into outgoing stream.
            .then(() => console.log(data)) // Only print if successful.
            .finally(); // Ignore any errors.
    });

    // If a processor upstream terminates the channel, we propagate this change
    // onto the processors downstream.
    incoming.on("end", () => {
        outgoing
            .end()
            .then(() => console.log("Incoming stream terminated."))
            .finally();
    });

    /**************************************************************************
     * Any code that must be executed after the pipeline goes online must be  *
     * embedded in the returned function. This guarantees that all channels   *
     * are initialized and the other processors are available. A common use   *
     * case is the source processor, which introduces data into the pipeline  *
     * from an external source such as the file system or an HTTP API, since  *
     * these must be certain that the downstream processors are ready and     *
     * awaiting data.                                                         *
     *                                                                        *
     * Note that this entirely optional, and you may return void instead.     *
     **************************************************************************/
    return async () => {
        // await outgoing.push("You're being logged. Do not resist.");
    };
}

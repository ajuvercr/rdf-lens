import { readFile } from "fs/promises";
import type * as RDF from "@rdfjs/types";
import { RDF as RDFT, RelationType, SDS } from "@treecg/types";
import { Parser } from "n3";

import { extractShapes, match, subject } from "../../../src/index";

export type Record = {
    stream: string;
    payload: string;
    buckets: string[];
    dataless?: boolean;
};

export type Bucket = {
    id: string;
    streamId: string;
    immutable?: boolean;
    root?: boolean;
    empty?: boolean;
};

export type RdfThing = {
    id: RDF.Term;
    quads: RDF.Quad[];
};

export type Relation = {
    type: RelationType;
    stream: string;
    origin: string;
    bucket: string;
    value?: RdfThing;
    path?: RdfThing;
};

async function setupLenses() {
    const shape_str = await readFile("/shape.ttl", { encoding: "utf8" });
    const Shapes = extractShapes(new Parser().parse(shape_str));
    const RecordLens = match(undefined, SDS.terms.payload, undefined)
        .thenAll(subject)
        .thenSome(Shapes.lenses["Record"]);

    const BucketLens = match(
        undefined,
        RDFT.terms.type,
        SDS.terms.custom("Bucket"),
    )
        .thenAll(subject)
        .thenSome(Shapes.lenses["Bucket"]);

    const RelationLens = match(
        undefined,
        RDFT.terms.type,
        SDS.terms.custom("Relation"),
    )
        .thenAll(subject)
        .thenSome(Shapes.lenses["Relation"]);

    return { RecordLens, BucketLens, RelationLens };
}

async function getData() {
    const data_str = await readFile("/data.ttl", { encoding: "utf8" });
    const quads = new Parser().parse(data_str);

    return quads.filter((q) =>
        q.graph.equals(SDS.terms.custom("DataDescription")),
    );
}

describe("test empty ids get extracted", async () => {
    const lenses = await setupLenses();
    const data = await getData();

    test("Records get extracted", () => {
        const records = <Record[]>lenses.RecordLens.execute(data);
        console.log(records);
        expect(2).toBe(4);
    });
    const buckets = <Bucket[]>lenses.BucketLens.execute(data);
});

import { describe, expect, test } from "vitest";
import { NamedNode, Quad, Term } from "@rdfjs/types";
import { DataFactory } from "rdf-data-factory";
import {
    BasicLens,
    BasicLensM,
    Cont,
    empty,
    match,
    object,
    pred,
    subject,
} from "../src";
import { Parser } from "n3";

function execTest<T>(
    quadString: string,
    lens: BasicLens<Cont, T>,
    id: string,
): T {
    const quads = new Parser().parse(quadString);
    return lens.execute({ id: factory.namedNode(id), quads });
}

type RecordOf<TKey extends (string | number | symbol)[], TValue> = Record<
    TKey[number],
    TValue
>;

const factory = new DataFactory();
export type Namespace<
    TKey extends (string | number | symbol)[],
    TValue,
    IValue,
> = {
    namespace: TValue;
    custom: (input: IValue) => TValue;
} & RecordOf<TKey, TValue>;

export function createNamespace<
    TKey extends string,
    TValue,
    IValue extends string,
>(
    baseUri: string,
    toValue: (expanded: string) => TValue,
    ...localNames: TKey[]
): Namespace<typeof localNames, TValue, IValue> {
    const expanded: Namespace<typeof localNames, TValue, IValue> =
        {} as Namespace<typeof localNames, TValue, IValue>;
    // Expose the main namespace
    expanded.namespace = toValue(baseUri);
    expanded.custom = (v) => toValue(baseUri + v);
    // Expose the listed local names as properties
    for (const localName of localNames) {
        (expanded as RecordOf<TKey[], TValue>)[localName] = toValue(
            `${baseUri}${localName}`,
        );
    }
    return expanded;
}

export function createTermNamespace<T extends string>(
    baseUri: string,
    ...localNames: T[]
): Namespace<typeof localNames, NamedNode, string> {
    return createNamespace(baseUri, factory.namedNode, ...localNames);
}

const EX = createTermNamespace("", "target");

const RDF = createTermNamespace(
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
    "nil",
    "rest",
    "first",
    "type",
);

const RDFS = createTermNamespace(
    "http://www.w3.org/2000/01/rdf-schema#",
    "Class",
);

const SHACL = createTermNamespace(
    "http://www.w3.org/ns/shacl#",
    // Basics
    "Shape",
    "NodeShape",
    "PropertyShape",
    // SHACL target constraints
    "targetNode",
    "targetClass",
    "targetSubjectsOf",
    "targetObjectsOf",
    // Property things
    "property",
    "path",
    "class",
    "name",
    "description",
    "defaultValue",
    // Path things
    "alternativePath",
    "zeroOrMorePath",
    "inversePath",
);

const RDFListElement = pred(RDF.first).one().and(pred(RDF.rest).one());
const RdfList: BasicLens<Cont, Term[]> = new BasicLens((c) => {
    if (c.id.equals(RDF.nil)) {
        return [];
    }

    const [first, rest] = RDFListElement.execute(c);
    const els = RdfList.execute(rest);
    els.unshift(first.id);
    return els;
});

const ShaclSequencePath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c) => {
    const pathList = RdfList.execute(c);

    if (pathList.length === 0) {
        return new BasicLensM((c) => [c]);
    }

    let start = pred(pathList[0]);

    for (let i = 1; i < pathList.length; i++) {
        start = start.thenFlat(pred(pathList[i]));
    }

    return start;
});

const ShaclAlternativepath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c) => {
    const options = pred(SHACL.alternativePath).one().then(RdfList).execute(c);
    const optionLenses = options.map((id) =>
        ShaclPath.execute({ id, quads: c.quads }),
    );
    return optionLenses[0].orAll(...optionLenses.slice(1));
});

const ShaclPredicatePath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c) => {
    return pred(c.id);
});

const ShaclPath = ShaclSequencePath.or(
    ShaclAlternativepath,
    ShaclPredicatePath,
);

// TODO: add datatype and stuff like that
// Mincount is also required for optional fields
const ShaclProperty: BasicLens<
    Cont,
    BasicLens<Cont, { name?: string; value: string[] }>
> = new BasicLens((c) => {
    const [path, nameCont] = pred(SHACL.path)
        .one()
        .then(ShaclPath)
        .and(pred(SHACL.name).one(undefined))
        .execute(c);
    const name = nameCont?.id.value;

    return new BasicLens((c: Cont) => {
        const value = path.execute(c).map((c) => c.id.value);
        return { name, value };
    });
});

type Obj = {
    fields: { name?: string; value: string[] }[];
    type: string;
    id: string;
};

const TargetNode: BasicLens<Cont<Term>, BasicLensM<Quad[], Cont<Term>>> = pred(
    SHACL.targetNode,
).map((ids) => new BasicLensM((quads) => ids.map(({ id }) => ({ id, quads }))));

const TargetClass: BasicLens<Cont<Term>, BasicLensM<Quad[], Cont<Term>>> = pred(
    SHACL.targetClass,
)
    .expectOne()
    .map((node) => {
        return match(undefined, RDF.type, node.id).thenAll(subject);
    });

const ImpTargetClass: BasicLens<Cont<Term>, BasicLensM<Quad[], Cont<Term>>> =
    // Look for type declarations and filter out RDFS.class
    // If there is one, the subjects is the expected class
    pred(RDF.type)
        .filter(({ id }) => id.equals(RDFS.Class))
        .expectOne()
        .and(empty<Cont<Term>>())
        .map(([_, start]) =>
            match(undefined, RDF.type, start.id).thenAll(subject),
        );

const TargetSubjectsOf: BasicLens<
    Cont<Term>,
    BasicLensM<Quad[], Cont<Term>>
> = pred(SHACL.targetSubjectsOf)
    .expectOne()
    .map((pred) => match(undefined, pred.id, undefined).thenAll(subject));

const TargetObjectsOf: BasicLens<
    Cont<Term>,
    BasicLensM<Quad[], Cont<Term>>
> = pred(SHACL.targetObjectsOf)
    .expectOne()
    .map((pred) => match(undefined, pred.id, undefined).thenAll(object));

const ShaclTargets: BasicLens<
    Cont<Term>,
    BasicLensM<Quad[], Cont<Term>>
> = new BasicLens((c) => {
    /// Try all of these things
    const ret = TargetNode.orM(
        TargetClass,
        ImpTargetClass,
        TargetSubjectsOf,
        TargetObjectsOf,
    ).execute(c);

    /// Combine the results
    return ret[0].orAll(...ret.slice(1));
});

const ShaclExtract: BasicLensM<Quad[], BasicLensM<Quad[], Obj>> = match(
    undefined,
    RDF.type,
    SHACL.NodeShape,
)
    .thenAll(subject)
    .mapAll((subj) => {
        // Follow property to extract all shacl properties
        const [fieldLenses, target] = pred(SHACL.property)
            .thenAll(ShaclProperty)
            .and(ShaclTargets)
            .execute(subj);

        // These properties are 'and' together
        const fieldsLens = fieldLenses[0]
            .and(...fieldLenses.slice(1))
            .asMulti();
        // These properties are getting extracted from all subjects
        const fromSub = target.thenSome(fieldsLens.and(empty<Cont>()));

        return fromSub.mapAll(([fields, cont]) => ({
            type: subj.id.value,
            fields,
            id: cont.id.value,
        }));
    });

describe("Basic", () => {
    test("Empty List", () => {
        const list = execTest(
            "<test> <target> ( ).",
            pred(EX.target).one().then(RdfList),
            "test",
        );
        expect(list.length).toBe(0);
        expect(list.map((x) => x.value)).toEqual([]);
    });

    test("Rdf List", () => {
        const list = execTest(
            "<test> <target> (<a> <b> <c>).",
            pred(EX.target).one().then(RdfList),
            "test",
        );
        expect(list.length).toBe(3);
        expect(list.map((x) => x.value)).toEqual(["a", "b", "c"]);
    });

    test("RDF List invalid list", () => {
        const tryExec = () =>
            execTest(
                "<test> <target> [].",
                pred(EX.target).one().then(RdfList),
                "test",
            );
        expect(tryExec).toThrow();
    });
});

describe("Shacl", () => {
    test("Single Path", () => {
        const shaclPathTurtle = "<test> <target> <pred1>.";
        const pathLens = execTest(
            shaclPathTurtle,
            pred(EX.target).one().then(ShaclPath),
            "test",
        );

        const turtle = "<test> <pred1> <a>. <test> <pred1> <b>.";
        const out = execTest(turtle, pathLens, "test");
        expect(out.length).toBe(2);
        expect(out.map((x) => x.id.value)).toEqual(["a", "b"]);
    });

    test("Path list", () => {
        const shaclPathTurtle = "<test> <target> (<pred1> <pred2>).";
        const pathLens = execTest(
            shaclPathTurtle,
            pred(EX.target).one().then(ShaclPath),
            "test",
        );

        const turtle = "<test> <pred1> [ <pred2> <a> ]. <test> <pred1> <b>.";
        const out = execTest(turtle, pathLens, "test");
        expect(out.length).toBe(1);
        expect(out.map((x) => x.id.value)).toEqual(["a"]);
    });

    test("alternative path", () => {
        const shaclPathTurtle = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
<test> sh:path [ sh:alternativePath ( <a> (<b> <c>) )].
`;
        const propertyLens = execTest(
            shaclPathTurtle,
            pred(SHACL.path).one().then(ShaclPath),
            "test",
        );

        const turtle = "<test> <b> [<c> 42]. <test> <a> 43.";
        const found = execTest(turtle, propertyLens, "test");
        expect(found.length).toBe(2);
        const foundLit = found.map((x) => x.id.value);
        expect(foundLit).toContain("42");
        expect(foundLit).toContain("43");
    });

    test("Property predicate", () => {
        const shaclPathTurtle = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
<test> sh:property [ sh:path <pre1>; sh:name "pred1" ].
`;
        const propertyLens = execTest(
            shaclPathTurtle,
            pred(SHACL.property).one().then(ShaclProperty),
            "test",
        );

        const turtle = "<test> <pre1> 42.";
        const found = execTest(turtle, propertyLens, "test");
        expect(found.name).toEqual("pred1");
        expect(found.value.length).toBe(1);
        expect(found.value).toEqual(["42"]);
    });

    test("Property path", () => {
        const shaclPathTurtle = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
<test> sh:property [ sh:path (<a> <b>); sh:name "pred2" ].
`;
        const propertyLens = execTest(
            shaclPathTurtle,
            pred(SHACL.property).one().then(ShaclProperty),
            "test",
        );

        const turtle = "<test> <a> [<b> 42].";
        const found = execTest(turtle, propertyLens, "test");
        expect(found.name).toEqual("pred2");
        expect(found.value.length).toBe(1);
        expect(found.value).toEqual(["42"]);
    });
});

describe("Shacl Nodeshapes", () => {
    test("Find node shape shapes", () => {
        const shapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
<person>
	a sh:NodeShape ;
	sh:targetClass <Person> ;
	sh:property [
		sh:path <name> ;
    sh:name "name" ;
	] .

<point>
	a sh:NodeShape ;
	sh:targetClass <Point> ;
	sh:property [
		sh:path <x> ;
    sh:name "x" ;
	], [
		sh:path <y> ;
    sh:name "y" ;
  ] .
`;
        const quads = new Parser().parse(shapes);
        const shapeLenses = ShaclExtract.execute(quads);

        expect(shapeLenses.length).toEqual(2);

        const data = `
<point1> a <Point>;
  <x> 42;
  <y> 23.
<point2> a <Point>;
  <x> 42;
  <y> 23.

<person> a <Person>;
  <name> "John".
`;
        const dataQuads = new Parser().parse(data);
        const found = shapeLenses.flatMap((lens) => lens.execute(dataQuads));
        expect(found.length).toBe(3);
    });

    test("Shacl implicit target class", () => {
        const shapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<Person>
	a sh:NodeShape, rdfs:Class ;
	sh:property [
		sh:path <name> ;
    sh:name "name" ;
	] .
`;
        const quads = new Parser().parse(shapes);
        const shapeLenses = ShaclExtract.execute(quads);

        expect(shapeLenses.length).toEqual(1);

        const data = `
<point1> a <Point>;
  <x> 42;
  <y> 23.

<person> a <Person>;
  <name> "John".
`;
        const dataQuads = new Parser().parse(data);
        const found = shapeLenses.flatMap((lens) => lens.execute(dataQuads));
        expect(found.length).toBe(1);
    });

    test("Find node shape shapes", () => {
        const shapes = `
@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

<person>
	a sh:NodeShape;
	sh:targetSubjectsOf <name>;
	sh:property [
		sh:path <name> ;
    sh:name "name" ;
	] .
`;
        const quads = new Parser().parse(shapes);
        const shapeLenses = ShaclExtract.execute(quads);

        expect(shapeLenses.length).toEqual(1);

        const data = `
<point1> a <Point>;
  <x> 42;
  <y> 23.

<person> a <Person>;
  <name> "John".
`;
        const dataQuads = new Parser().parse(data);
        const found = shapeLenses.flatMap((lens) => lens.execute(dataQuads));
        expect(found.length).toBe(1);
    });
});

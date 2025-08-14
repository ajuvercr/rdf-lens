import { Quad, Quad_Object, Term } from "@rdfjs/types";
import { RDF, XSD } from "@treecg/types";
import {
    BasicLens,
    BasicLensM,
    Cont,
    createContext,
    empty,
    invPred,
    LensContext,
    LensError,
    match,
    pred,
    subject,
    subjects,
    unique,
} from "./lens";

import { DataFactory, NamedNode } from "rdf-data-factory";
import { RDFL, RDFS, SHACL } from "./ontology";

const { literal, quad } = new DataFactory();

function termToString(term: Term): string {
    if (term.termType === "NamedNode") {
        return "<" + term.value + ">";
    }
    if (term.termType === "BlankNode") {
        return "_:" + term.value;
    }
    return JSON.stringify(term.value);
}

/**
 * ShapeField describes a field/property in a SHACL shape, including its name, path, cardinality, and extraction lens
 */
export interface ShapeField {
    name: string;
    path: BasicLensM<Cont, Cont>;
    minCount?: number;
    maxCount?: number;
    extract: BasicLens<Cont, unknown>;
}

/**
 * Shape represents a SHACL node shape, including its identifier, type, description, and fields
 */
export interface Shape {
    id: string;
    ty: Term;
    description?: string;
    fields: ShapeField[];
}

function fieldToLens(field: ShapeField): BasicLens<Cont, unknown> {
    const minCount = field.minCount || 0;
    const maxCount = field.maxCount || Number.MAX_SAFE_INTEGER;
    if (maxCount < 2) {
        return field.path.one(undefined).then(
            new BasicLens((x, ctx) => {
                if (x) {
                    return field.extract.execute(x, ctx);
                } else {
                    if (minCount > 0) {
                        throw new LensError(
                            "Field is not defined and required",
                            ctx.lineage.slice(),
                        );
                    } else {
                        return x;
                    }
                }
            }),
        );
    }
    if (maxCount < 2) return field.path.one().then(field.extract);

    const thenListExtract = RdfList.and(empty<Cont>()).map(
        ([terms, { quads }]) => terms.map((id) => ({ id, quads })),
    );
    const noListExtract = empty<Cont>().map((x) => [x]);

    return field.path
        .thenFlat(thenListExtract.or(noListExtract).asMulti())
        .thenAll(field.extract)
        .map((x) => x.filter((x) => x !== undefined))
        .map((xs, ctx) => {
            if (xs.length < minCount) {
                throw new LensError("Mininum Count violation", [
                    { name: "found:", opts: xs.length },
                    ...ctx.lineage.slice(),
                ]);
            }
            if (xs.length > maxCount) {
                throw new LensError("Maximum Count violation", [
                    { name: "found: " + xs.length, opts: [] },
                    ...ctx.lineage.slice(),
                ]);
            }
            return xs;
        })
        .map((x) => {
            const out = x.filter((x) => x !== undefined);
            if (maxCount < 2) {
                return out[0];
            } else {
                return out;
            }
        });
}
/**
 * Converts a Shape definition into a BasicLens that extracts data objects matching the shape.
 * Handles field cardinality (minCount/maxCount), list extraction, and field mapping.
 * Throws if required fields are missing or cardinality is violated.
 */
export function toLens(
    shape: Shape,
): BasicLens<Cont, { [label: string]: unknown }> {
    if (shape.fields.length === 0)
        return empty<Cont>()
            .map(() => ({}))
            .named("first", shape.ty.value)
            .named("shape", {
                id: shape.id,
                type: termToString(shape.ty),
                description: shape.description,
            })
            .named("id", [], (cont) => termToString(cont.id));
    const fields = shape.fields.map((field) => {
        const base = fieldToLens(field);

        const asField = empty<Cont>()
            .named("processing field", {
                name: field.name,
                minCount: field.minCount,
                maxCount: field.maxCount,
            })
            .then(base)
            .map((x) => {
                const out = <{ [label: string]: unknown }>{};
                out[field.name] = x;
                return out;
            });

        return asField;
    });

    return fields[0]
        .and(...fields.slice(1))
        .map((xs) => Object.assign({}, ...xs))
        .named("shape", {
            id: shape.id,
            type: termToString(shape.ty),
            description: shape.description,
        })
        .named("id", [], (cont) => termToString(cont.id));
}

/**
 * RDFListElement extracts the 'first' and 'rest' links from an RDF collection (list)
 */
const RDFListElement = pred(RDF.terms.first)
    .expectOne()
    .and(pred(RDF.terms.rest).expectOne());

/**
 * RdfList extracts an array of Terms from an RDF collection (rdf:List), recursively traversing 'rest'.
 * Returns an empty array for rdf:nil (the end of the list).
 */
export const RdfList: BasicLens<Cont, Term[]> = new BasicLens((c, ctx) => {
    if (c.id.equals(RDF.terms.nil)) {
        return [];
    }

    const [first, rest] = RDFListElement.execute(c, ctx);
    const els = RdfList.execute(rest, ctx);
    els.unshift(first.id);
    return els;
});

/**
 * ShaclSequencePath interprets a SHACL sequence path (sh:sequencePath), chaining lenses for each step in the sequence.
 * Returns a composed lens that follows the full sequence.
 */
export const ShaclSequencePath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c, ctx) => {
    const pathList = RdfList.execute(c, ctx);
    const paths = pathList.map((x) =>
        ShaclPath.execute({ id: x, quads: c.quads }, ctx),
    );

    if (paths.length === 0) {
        return new BasicLensM((c) => [c]);
    }

    let start = paths[0];

    for (let i = 1; i < pathList.length; i++) {
        start = start.thenFlat(paths[i]);
    }

    return start;
});

/**
 * ShaclAlternativepath interprets a SHACL alternative path (sh:alternativePath), creating a lens that matches any of the options.
 * Returns a lens that tries all options and returns the result of the first that matches.
 */
export const ShaclAlternativepath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c, ctx) => {
    const options = pred(SHACL.alternativePath)
        .one()
        .then(RdfList)
        .execute(c, ctx);
    const optionLenses = options.map((id) =>
        ShaclPath.execute({ id, quads: c.quads }, ctx),
    );
    return optionLenses[0].orAll(...optionLenses.slice(1));
});

/**
 * ShaclPredicatePath extracts a simple predicate path (an IRI), mapping it to a lens that follows that predicate.
 */
export const ShaclPredicatePath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = extractLeaf(XSD.terms.custom("iri")).map(pred);

/**
 * ShaclInversePath interprets a SHACL inverse path (sh:inversePath), reversing the direction of a path or sequence of paths.
 * Returns a lens that follows the inverse of the given path(s).
 */
export const ShaclInversePath: BasicLens<Cont, BasicLensM<Cont, Cont>> = pred(
    SHACL.inversePath,
)
    .one()
    .then(
        new BasicLens<Cont, BasicLensM<Cont, Cont>>((c, ctx) => {
            const pathList = RdfList.execute(c, ctx);

            if (pathList.length === 0) {
                return new BasicLensM((c) => [c]);
            }

            pathList.reverse();

            let start = invPred(pathList[0]);

            for (let i = 1; i < pathList.length; i++) {
                start = start.thenFlat(invPred(pathList[i]));
            }

            return start;
        }).or(
            new BasicLens<Cont, BasicLensM<Cont, Cont>>((c) => {
                return invPred(c.id);
            }),
        ),
    );

/**
 * MultiPath creates a lens for SHACL multi-paths (e.g., zeroOrMorePath, zeroOrOnePath), following a path zero or more times as specified.
 * Handles minimum/maximum path repetitions and returns all reachable nodes.
 */
export function MultiPath(
    predicate: Term,
    min: number,
    max?: number,
): BasicLens<Cont, BasicLensM<Cont, Cont>> {
    return pred(predicate)
        .one()
        .then(
            new BasicLens<Cont, BasicLensM<Cont, Cont>>((c, ctx) => {
                return ShaclPath.execute(c, ctx);
            }),
        )
        .map(
            (x) =>
                new BasicLensM<Cont, Cont>((c, ctx) => {
                    const out: Cont[] = [];
                    let current = [c];
                    let done = 0;

                    if (min == 0) {
                        out.push(c);
                    }

                    while (current.length > 0) {
                        done += 1;
                        const todo = current.slice();
                        current = [];
                        for (const c of todo) {
                            try {
                                const news = x.execute(c, ctx);
                                current.push(...news);

                                if (done >= min && (!max || done <= max)) {
                                    out.push(c);
                                }
                            } catch (ex) {
                                console.log(ex);
                                if (done >= min && (!max || done <= max)) {
                                    out.push(c);
                                }
                                break;
                            }
                        }
                    }

                    return out;
                }),
        );
}

/**
 * ShaclPath is a union of all SHACL path types (sequence, alternative, inverse, multi, and predicate paths).
 * It tries each path type in order and returns the result for the first matching type.
 */
export const ShaclPath = ShaclSequencePath.or(
    ShaclAlternativepath,
    ShaclInversePath,
    MultiPath(SHACL.zeroOrMorePath, 0),
    MultiPath(SHACL.zeroOrMorePath, 1),
    MultiPath(SHACL.zeroOrOnePath, 0, 1),
    ShaclPredicatePath,
);

/**
 * field creates a lens that extracts a single property value from a node, converting it if needed, and maps it to a named object property.
 */
function field<T extends string, O = string>(
    predicate: Term,
    name: T,
    convert?: (inp: string) => O,
): BasicLens<Cont, { [F in T]: O }> {
    const conv = convert || ((x: string) => <O>x);

    return pred(predicate)
        .one()
        .map(({ id }) => {
            const out = <{ [F in T]: O }>{};
            out[name] = conv(id.value);
            return out;
        });
}

function f<T extends string, O>(
    predicate: Term,
    name: T,
    lens: BasicLens<Cont, O>,
): BasicLens<Cont, { [F in T]: O }> {
    return pred(predicate)
        .one()
        .then(lens)
        .map((item) => {
            const out = <{ [F in T]: O }>{};
            out[name] = item;
            return out;
        });
}

const getId: BasicLens<Cont, Term> = empty<Cont>().map(({ id }) => id);
function constValue<T, O>(value: O): BasicLens<T, O> {
    return empty<T>().map(() => value);
}

/**
 * optionalField creates a lens that extracts an optional property value from a node, converting it if present, and maps it to a named object property (or undefined).
 */
function optionalField<T extends string, O = string>(
    predicate: Term,
    name: T,
    convert?: (inp: string) => O | undefined,
): BasicLens<Cont, { [F in T]: O | undefined }> {
    const conv = convert || ((x: string) => <O | undefined>x);

    return pred(predicate)
        .one(undefined)
        .map((inp) => {
            const out = <{ [F in T]: O | undefined }>{};
            if (inp) {
                out[name] = conv(inp.id.value);
            }
            return out;
        });
}

/**
 * dataTypeToExtract converts a Term value to a native JS value based on the given XSD datatype (e.g., integer, float, boolean, dateTime, IRI).
 */
function dataTypeToExtract(dataType: Term, t: Term): unknown {
    if (dataType.equals(XSD.terms.integer)) return +t.value;
    if (dataType.equals(XSD.terms.custom("float"))) return +t.value;
    if (dataType.equals(XSD.terms.custom("double"))) return +t.value;
    if (dataType.equals(XSD.terms.custom("decimal"))) return +t.value;
    if (dataType.equals(XSD.terms.string)) return t.value;
    if (dataType.equals(XSD.terms.dateTime)) return new Date(t.value);
    if (dataType.equals(XSD.terms.custom("boolean"))) return t.value === "true";
    if (dataType.equals(XSD.terms.custom("iri"))) return new NamedNode(t.value);
    if (dataType.equals(XSD.terms.custom("anyURI"))) {
        return new NamedNode(t.value);
    }

    return t;
}

/**
 * Cache is a mapping of class IRIs to their extraction lenses
 */
type Cache = {
    [clazz: string]: BasicLens<Cont, unknown>;
};

/**
 * SubClasses is a mapping of class IRIs to their parent class IRIs (for subclass hierarchy traversal)
 */
type SubClasses = {
    [clazz: string]: string;
};

/**
 * envLens extracts environment variables from RDF nodes of type EnvVariable, with optional default and datatype conversion.
 * Throws if variable is missing and no default is set.
 */
function envLens(dataType?: Term): BasicLens<Cont, unknown> {
    const checkType = pred(RDF.terms.type)
        .thenSome(
            new BasicLens(({ id }, ctx) => {
                if (!id.equals(RDFL.terms.EnvVariable)) {
                    throw new LensError(
                        "Expected type " + RDFL.EnvVariable,
                        ctx.lineage,
                    );
                }
                return { checked: true };
            }),
        )
        .expectOne();

    const envName = pred(RDFL.terms.envKey)
        .one()
        .map(({ id }) => ({
            key: id.value,
        }));

    const defaultValue = pred(RDFL.terms.envDefault)
        .one(undefined)
        .map((found) => ({
            defaultValue: found?.id.value,
        }));

    const envDatatype = pred(RDFL.terms.datatype)
        .one(undefined)
        .map((found) => ({ dt: found?.id }));

    return checkType
        .and(envName, defaultValue, envDatatype)
        .map(([_, { key }, { defaultValue }, { dt }], ctx) => {
            const value = process.env[key] || defaultValue;
            const thisDt = dataType || dt || XSD.terms.custom("literal");

            if (value) {
                return dataTypeToExtract(thisDt, literal(value));
            } else {
                throw new LensError("ENV and default are not set", [
                    { name: "Env Key", opts: key },
                    ...ctx.lineage,
                ]);
            }
        });
}

/**
 * sliced returns a shallow copy of an array (utility lens for array manipulation).
 */
export function sliced<T>(): BasicLens<T[], T[]> {
    return new BasicLens((x) => x.slice());
}

/**
 * remove_cbd removes all quads in the Concise Bounded Description (CBD) of a subject from the quad array.
 * Traverses blank nodes recursively.
 */
function remove_cbd(quads: Quad[], subject: Term) {
    const toRemoves = [subject];
    while (toRemoves.length > 0) {
        const toRemove = toRemoves.pop();

        quads = quads.filter((q) => {
            if (q.subject.equals(toRemove)) {
                if (q.object.termType === "BlankNode") {
                    toRemoves.push(q.object);
                }
                return false;
            } else {
                return true;
            }
        });
    }
    return quads;
}

/**
 * envReplace replaces references to EnvVariables in quads with their resolved values, using remove_cbd to remove original references.
 * Returns a new quad array with replacements.
 */
export function envReplace(): BasicLens<Quad[], Quad[]> {
    const shouldReplace = empty<[Cont, Quad[]]>()
        .map((x) => x[0])
        .then(envLens().and(empty<Cont>().map((x) => x.id)))
        .map(([value, id]) => ({
            value,
            id,
        }));

    const reduce: BasicLens<[Cont, Quad[]], Quad[]> = shouldReplace
        .and(empty<[Cont, Quad[]]>().map((x) => x[1]))
        .map(([{ value, id }, quads]) => {
            return remove_cbd(
                quads.map((q) => {
                    if (q.object.equals(id)) {
                        return quad(
                            q.subject,
                            q.predicate,
                            <Quad_Object>value,
                            q.graph,
                        );
                    } else {
                        return q;
                    }
                }),
                id,
            );
        });

    const actualReplace = match(
        undefined,
        RDF.terms.type,
        RDFL.terms.EnvVariable,
    )
        .thenAll(subject)
        .reduce(reduce, empty<Quad[]>());

    return sliced<Quad>().then(actualReplace);
}

/**
 * extractLeaf creates a lens that extracts a leaf value from a node, using envLens if available, otherwise converting by datatype.
 */
function extractLeaf(datatype: Term): BasicLens<Cont, unknown> {
    return envLens(datatype).or(
        empty<Cont>().map((item) => dataTypeToExtract(datatype, item.id)),
    );
}

/**
 * extractProperty extracts a ShapeField from a SHACL property definition, handling path, name, min/max count, datatype/class, and extraction lens.
 * Throws if a required class extraction lens is missing.
 */
function extractProperty(
    cache: Cache,
    _subClasses: SubClasses,
    apply: { [clazz: string]: (item: unknown) => unknown },
): BasicLens<Cont, ShapeField> {
    const pathLens = pred(SHACL.path)
        .one()
        .then(ShaclPath)
        .map((path) => ({
            path,
        }));
    const nameLens = field(SHACL.name, "name");
    const minCount = optionalField(SHACL.minCount, "minCount", (x) => +x);
    const maxCount = optionalField(SHACL.maxCount, "maxCount", (x) => +x);

    const dataTypeLens: BasicLens<Cont, { extract: ShapeField["extract"] }> =
        pred(SHACL.datatype)
            .one()
            .map(({ id }) => ({
                extract: extractLeaf(id),
            }));

    const clazzLens: BasicLens<Cont, { extract: ShapeField["extract"] }> =
        field(SHACL.class, "clazz").map(({ clazz: expected_class }) => {
            return {
                extract: new BasicLens<Cont, unknown>(({ id, quads }, ctx) => {
                    // We did not find a type, so use the expected class lens
                    const lens = cache[expected_class];
                    if (!lens) {
                        throw new LensError(
                            "Tried extracting class, but no shape was defined",
                            [
                                {
                                    name: "Found type: " + expected_class,
                                    opts: Object.keys(cache),
                                },
                                ...ctx.lineage.slice(),
                            ],
                        );
                    }
                    if (apply[expected_class]) {
                        return lens
                            .map(apply[expected_class])
                            .execute({ id, quads }, ctx);
                    } else {
                        return lens.execute({ id, quads }, ctx);
                    }
                }).named("extracting class", expected_class),
            };
        });

    return pathLens
        .and(nameLens, minCount, maxCount, clazzLens.or(dataTypeLens))
        .map((xs) => Object.assign({}, ...xs));
}

/**
 * CBDLens extracts the Concise Bounded Description (CBD) for a subject from a set of quads, traversing blank nodes recursively.
 */
export const CBDLens = new BasicLensM<Cont, Quad>(({ id, quads }, cont) => {
    cont.lineage.push({ name: "CBD", opts: ["from: " + id.value] });
    const done = new Set<string>();
    const todo = [id];
    const out: Quad[] = [];
    let item = todo.pop();
    while (item) {
        const found = quads.filter((x) => x.subject.equals(item));
        out.push(...found);
        for (const option of found) {
            const object = option.object;
            if (object.termType !== "BlankNode") {
                continue;
            }

            if (done.has(object.value)) continue;
            done.add(object.value);
            todo.push(object);
        }
        item = todo.pop();
    }
    return out;
});

/**
 * StateDict is used for caching lens execution results by node id and lens
 */
type StateDict = {
    [id: string]: { lens: BasicLens<Cont, unknown>; result: unknown }[];
};

/**
 * CachedLens stores cached lens instances and their originating lenses
 */
type CachedLens = {
    lenses: {
        lens: BasicLens<Cont, unknown>;
        from: BasicLens<Cont, unknown>;
    }[];
};

/**
 * getCacheState retrieves or initializes a cache state object for a lens in a given context.
 */
function getCacheState<I, O, T>(
    le: BasicLens<I, O>,
    ctx: LensContext,
    st: () => T,
): T {
    const out = <T | undefined>ctx.stateMap.get(le);
    if (out !== undefined) return out;

    const o = st();
    ctx.stateMap.set(le, o);
    return o;
}

/**
 * Cached wraps a lens with caching logic, so repeated executions on the same node return cached results.
 * Useful for handling cycles and repeated references in RDF graphs.
 */
export const Cached = function (
    lens: BasicLens<Cont, unknown>,
    cachedLenses: CachedLens,
): BasicLens<Cont, unknown> {
    const lenses = cachedLenses["lenses"] ?? (cachedLenses.lenses = []);

    const found = lenses.find((x) => x.from === lens);
    if (found) {
        return found.lens;
    }

    const newLens = new BasicLens<Cont, unknown>(({ id, quads }, ctx) => {
        const state = getCacheState(newLens, ctx, () => ({
            namedNodes: <StateDict>{},
            blankNodes: <StateDict>{},
        }));

        let stateDict: StateDict = {};
        if (id.termType == "NamedNode") {
            stateDict = state.namedNodes = state.namedNodes ?? {};
        }
        if (id.termType == "BlankNode") {
            stateDict = state.blankNodes = state.blankNodes ?? {};
        }

        if (!(id.value in stateDict!)) {
            stateDict[id.value] = [];
        }

        const res = stateDict![id.value].find((x) => x.lens == lens);
        if (res) {
            return res.result;
        }

        const thisThing = { lens: lens, result: {} };
        stateDict[id.value].push(thisThing);

        const executedLens = lens.execute({ quads, id }, ctx);
        Object.assign(thisThing.result, executedLens);

        return thisThing.result;
    });

    lenses.push({ lens: newLens, from: lens });
    return newLens;
};

/**
 * TypedExtract creates a lens that extracts data based on the rdf:type of a node, traversing subclass hierarchies and applying type-specific extraction lenses.
 * Throws if no extraction lens is found for a type.
 */
export const TypedExtract = function (
    cache: Cache,
    apply: ApplyDict,
    subClasses: SubClasses,
): BasicLens<Cont, unknown> {
    const lens = new BasicLens<Cont, unknown>(({ id, quads }, ctx) => {
        const ty = quads.find(
            (q) => q.subject.equals(id) && q.predicate.equals(RDF.terms.type),
        )?.object.value;

        ctx.lineage.push({ name: "Found type", opts: ty });
        ctx.lineage.push({ name: "TypedExtract", opts: undefined });

        if (!ty) {
            throw new LensError(
                "Expected a type, found none",
                ctx.lineage.slice(),
            );
        }

        // We found a type, let's see if the expected class is inside the class hierachry
        const lenses: (typeof cache)[string][] = [];

        let current = ty;
        while (current) {
            const thisLens = cache[current];
            if (thisLens) {
                const state: CachedLens = getCacheState(lens, ctx, () => ({
                    lenses: [],
                }));
                lenses.push(Cached(thisLens, <CachedLens>state));
            }
            current = subClasses[current];
        }

        if (lenses.length === 0) {
            throw new LensError(
                "Expected a lens for type, found none",
                ctx.lineage.slice(),
            );
        }

        const finalLens =
            lenses.length == 1
                ? lenses[0]
                : lenses[0]
                      .and(...lenses.slice(1))
                      .map((xs) => Object.assign({}, ...xs));

        if (apply[ty]) {
            return finalLens.map(apply[ty]).execute({ id, quads }, ctx);
        } else {
            return finalLens.execute({ id, quads }, ctx);
        }
    });
    return lens;
};

/**
 * ApplyDict is a mapping of type IRIs to post-processing functions applied after extraction
 */
export type ApplyDict = { [label: string]: (item: unknown) => unknown };

/**
 * extractShape extracts an array of Shape objects from RDF quads, using the provided cache, subclass mapping, and apply functions.
 * Handles targetClass, description, and property extraction for each shape.
 */
export function extractShape(
    cache: Cache,
    subclasses: { [label: string]: string },
    apply: ApplyDict,
): BasicLens<Cont, Shape[]> {
    const checkTy = pred(RDF.terms.type)
        .one()
        .map(({ id }, ctx) => {
            if (id.equals(SHACL.NodeShape)) return {};
            throw new LensError("Expected type sh:NodeShape", [
                { name: "found type", opts: termToString(id) },
                ...ctx.lineage,
            ]);
        });

    const idLens = empty<Cont>().map(({ id }) => ({ id: id.value }));
    const clazzs = pred(SHACL.targetClass);

    const multiple = clazzs.thenAll(
        empty<Cont>().map(({ id }) => ({ ty: id })),
    );

    // TODO: Add implictTargetClass
    const descriptionClassLens = optionalField(
        SHACL.description,
        "description",
    );
    const fields = pred(SHACL.property)
        .thenAll(extractProperty(cache, subclasses, apply))
        .map((fields) => ({ fields }));

    return multiple
        .and(checkTy, idLens, descriptionClassLens, fields)
        .map(([multiple, ...others]) =>
            multiple.map((xs) => <Shape>Object.assign({}, xs, ...others)),
        );
}

/**
 * Shapes bundles the extracted shapes, their lenses, and subclass hierarchy for downstream use.
 */
export type Shapes = {
    shapes: Shape[];
    lenses: Cache;
    subClasses: SubClasses;
};

/**
 * extractShapes is the main entry point for extracting SHACL shapes from RDF quads.
 * Builds the lens cache, subclass hierarchy, and extracts all shapes.
 * Optionally applies custom extraction logic for specific types.
 * Returns a Shapes object with all extracted shapes and supporting data.
 */
export function extractShapes(
    quads: Quad[],
    apply: ApplyDict = {},
    customClasses: Cache = {},
): Shapes {
    const cache: Cache = Object.assign({}, customClasses);

    cache[RDFL.PathLens] = ShaclPath;
    cache[RDFL.CBD] = <BasicLens<Cont, Quad[]>>CBDLens;
    cache[RDFL.Context] = new BasicLens(({ quads }) => {
        return quads;
    });
    const subClasses: SubClasses = {};
    quads
        .filter((x) => x.predicate.equals(RDFS.subClassOf))
        .forEach((x) => (subClasses[x.subject.value] = x.object.value));

    const shapes = subjects()
        .then(unique())
        .asMulti()
        .thenSome(extractShape(cache, subClasses, apply))
        .execute(quads, createContext())
        .flat();
    const lenses = [];

    cache[RDFL.TypedExtract] = TypedExtract(cache, apply, subClasses);

    // Populate cache
    for (const shape of shapes) {
        const lens = toLens(shape);
        const target = cache[shape.ty.value];

        if (target) {
            cache[shape.ty.value] = target.or(lens);
            // subClasses: shape.subTypes,
        } else {
            cache[shape.ty.value] = lens;
        }
        lenses.push(lens);
    }

    return { lenses: cache, shapes, subClasses };
}

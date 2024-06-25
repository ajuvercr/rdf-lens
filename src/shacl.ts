import { Quad, Term } from "@rdfjs/types";
import { RDF, XSD } from "@treecg/types";
import {
    BasicLens,
    BasicLensM,
    Cont,
    empty,
    invPred,
    pred,
    subjects,
    unique,
} from "./lens";

import { DataFactory } from "rdf-data-factory";
import { RDFL, RDFS, SHACL } from "./ontology";

const { literal } = new DataFactory();

export interface ShapeField {
    name: string;
    path: BasicLensM<Cont, Cont>;
    minCount?: number;
    maxCount?: number;
    extract: BasicLens<Cont, unknown>;
}

export interface Shape {
    id: string;
    ty: Term;
    description?: string;
    fields: ShapeField[];
}

export function toLens(
    shape: Shape,
): BasicLens<Cont, { [label: string]: unknown }> {
    if (shape.fields.length === 0) return empty<Cont>().map(() => ({}));

    const fields = shape.fields.map((field) => {
        const minCount = field.minCount || 0;
        const maxCount = field.maxCount || Number.MAX_SAFE_INTEGER;
        const base = (() => {
            if (maxCount < 2) {
                return field.path.one().then(
                    new BasicLens((x, _, states) => {
                        if (x) {
                            return field.extract.execute(x, states);
                        } else {
                            if (minCount > 0) {
                                throw "Thing is undefined " + field.name;
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
                .map((x) => x.filter((x) => !!x))
                .map((xs) => {
                    if (xs.length < minCount) {
                        throw `${shape.ty}:${field.name} required at least ${minCount} elements, found ${xs.length}`;
                    }
                    if (xs.length > maxCount) {
                        throw `${shape.ty}:${field.name} required at most ${maxCount} elements, found ${xs.length}`;
                    }
                    return xs;
                })
                .map((x) => {
                    const out = x.filter((x) => !!x);
                    if (maxCount < 2) {
                        // console.log(out, x);
                        return out[0];
                    } else {
                        return out;
                    }
                });
        })();

        const asField = base.map((x) => {
            const out = <{ [label: string]: unknown }>{};
            out[field.name] = x;
            return out;
        });

        return minCount > 0 ? asField : asField.or(empty().map(() => ({})));
    });

    return fields[0]
        .and(...fields.slice(1))
        .map((xs) => Object.assign({}, ...xs));
}

const RDFListElement = pred(RDF.terms.first)
    .expectOne()
    .and(pred(RDF.terms.rest).expectOne());

export const RdfList: BasicLens<Cont, Term[]> = new BasicLens(
    (c, _, states) => {
        if (c.id.equals(RDF.terms.nil)) {
            return [];
        }

        const [first, rest] = RDFListElement.execute(c, states);
        const els = RdfList.execute(rest, states);
        els.unshift(first.id);
        return els;
    },
);

export const ShaclSequencePath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c, _, states) => {
    const pathList = RdfList.execute(c, states);
    const paths = pathList.map((x) =>
        ShaclPath.execute({ id: x, quads: c.quads }),
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

export const ShaclAlternativepath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c, _, states) => {
    const options = pred(SHACL.alternativePath)
        .one()
        .then(RdfList)
        .execute(c, states);
    const optionLenses = options.map((id) =>
        ShaclPath.execute({ id, quads: c.quads }, states),
    );
    return optionLenses[0].orAll(...optionLenses.slice(1));
});

export const ShaclPredicatePath: BasicLens<
    Cont,
    BasicLensM<Cont, Cont>
> = new BasicLens((c) => {
    return pred(c.id);
});

export const ShaclInversePath: BasicLens<Cont, BasicLensM<Cont, Cont>> = pred(
    SHACL.inversePath,
)
    .one()
    .then(
        new BasicLens<Cont, BasicLensM<Cont, Cont>>((c, _, states) => {
            const pathList = RdfList.execute(c, states);

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

export function MultiPath(
    predicate: Term,
    min: number,
    max?: number,
): BasicLens<Cont, BasicLensM<Cont, Cont>> {
    return pred(predicate)
        .one()
        .then(
            new BasicLens<Cont, BasicLensM<Cont, Cont>>((c, _, states) => {
                return ShaclPath.execute(c, states);
            }),
        )
        .map(
            (x) =>
                new BasicLensM<Cont, Cont>((c, _, states) => {
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
                                const news = x.execute(c, states);
                                console.log("adding ", news.length, "news");
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

export const ShaclPath = ShaclSequencePath.or(
    ShaclAlternativepath,
    ShaclInversePath,
    MultiPath(SHACL.zeroOrMorePath, 0),
    MultiPath(SHACL.zeroOrMorePath, 1),
    MultiPath(SHACL.zeroOrOnePath, 0, 1),
    ShaclPredicatePath,
);

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
function dataTypeToExtract(dataType: Term, t: Term): unknown {
    if (dataType.equals(XSD.terms.integer)) return +t.value;
    if (dataType.equals(XSD.terms.custom("float"))) return +t.value;
    if (dataType.equals(XSD.terms.custom("double"))) return +t.value;
    if (dataType.equals(XSD.terms.custom("decimal"))) return +t.value;
    if (dataType.equals(XSD.terms.string)) return t.value;
    if (dataType.equals(XSD.terms.dateTime)) return new Date(t.value);
    if (dataType.equals(XSD.terms.custom("boolean"))) return t.value === "true";

    return t;
}

type Cache = {
    [clazz: string]: BasicLens<Cont, unknown>;
};

type SubClasses = {
    [clazz: string]: string;
};

function envLens(dataType: Term): BasicLens<Cont, unknown> {
    const checkType = pred(RDF.terms.type)
        .thenSome(
            new BasicLens(({ id }) => {
                if (!id.equals(RDFL.terms.EnvVariable)) {
                    throw "expected type " + RDFL.EnvVariable;
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

    return checkType
        .and(envName, defaultValue)
        .map(([_thing, { key }, { defaultValue }]) => {
            const value = process.env[key] || defaultValue;
            if (value) {
                return dataTypeToExtract(dataType, literal(value));
            } else {
                throw (
                    "Nothing set for ENV " +
                    key +
                    ". No default was set either!"
                );
            }
        });
}

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
                extract: envLens(id).or(
                    empty<Cont>().map((item) => dataTypeToExtract(id, item.id)),
                ),
            }));

    const clazzLens: BasicLens<Cont, { extract: ShapeField["extract"] }> =
        field(SHACL.class, "clazz").map(({ clazz: expected_class }) => {
            return {
                extract: new BasicLens<Cont, unknown>(
                    ({ id, quads }, _, states) => {
                        // We did not find a type, so use the expected class lens
                        const lens = cache[expected_class];
                        if (!lens) {
                            throw `Tried extracting class ${expected_class} but no shape was defined`;
                        }
                        if (apply[expected_class]) {
                            return lens
                                .map(apply[expected_class])
                                .execute({ id, quads }, states);
                        } else {
                            return lens.execute({ id, quads }, states);
                        }
                    },
                ),
            };
        });

    return pathLens
        .and(nameLens, minCount, maxCount, clazzLens.or(dataTypeLens))
        .map((xs) => Object.assign({}, ...xs));
}

export const CBDLens = new BasicLensM<Cont, Quad>(({ id, quads }) => {
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

type StateDict = {
    [id: string]: { lens: BasicLens<Cont, unknown>; result: unknown }[];
};
type CachedLens = {
    lenses: {
        lens: BasicLens<Cont, unknown>;
        from: BasicLens<Cont, unknown>;
    }[];
};
export const Cached = function (
    lens: BasicLens<Cont, unknown>,
    cachedLenses: CachedLens,
): BasicLens<Cont, unknown> {
    const lenses = cachedLenses["lenses"] ?? (cachedLenses.lenses = []);

    const found = lenses.find((x) => x.from === lens);
    if (found) {
        return found.lens;
    }

    const newLens = new BasicLens<Cont, unknown>(({ id, quads }, _, states) => {
        const state: { namedNodes: StateDict; blankNodes: StateDict } =
            <{ namedNodes: StateDict; blankNodes: StateDict }>(
                states[lens.index]
            ) ??
            (states[lens.index] = {
                namedNodes: <StateDict>{},
                blankNodes: <StateDict>{},
            });
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

        const executedLens = lens.execute({ quads, id }, states);
        Object.assign(thisThing.result, executedLens);

        return thisThing.result;
    });

    lenses.push({ lens: newLens, from: lens });
    return newLens;
};

export const TypedExtract = function (
    cache: Cache,
    apply: ApplyDict,
    subClasses: SubClasses,
): BasicLens<Cont, unknown> {
    return new BasicLens(({ id, quads }, state, states) => {
        const ty = quads.find(
            (q) => q.subject.equals(id) && q.predicate.equals(RDF.terms.type),
        )?.object.value;

        if (!ty) {
            return;
        }

        // We found a type, let's see if the expected class is inside the class hierachry
        const lenses: (typeof cache)[string][] = [];

        let current = ty;
        while (current) {
            const thisLens = cache[current];
            if (thisLens) {
                lenses.push(Cached(thisLens, <CachedLens>state));
            }
            current = subClasses[current];
        }

        if (lenses.length === 0) {
            // Maybe we just return here
            // Or we log
            // Or we make it conditional
            throw `Tried the classhierarchy for ${ty}, but found no shape definition`;
        }

        const finalLens =
            lenses.length == 1
                ? lenses[0]
                : lenses[0]
                      .and(...lenses.slice(1))
                      .map((xs) => Object.assign({}, ...xs));

        if (apply[ty]) {
            return finalLens.map(apply[ty]).execute({ id, quads }, states);
        } else {
            return finalLens.execute({ id, quads }, states);
        }
    });
};

export type ApplyDict = { [label: string]: (item: unknown) => unknown };
export function extractShape(
    cache: Cache,
    subclasses: { [label: string]: string },
    apply: ApplyDict,
): BasicLens<Cont, Shape[]> {
    const checkTy = pred(RDF.terms.type)
        .one()
        .map(({ id }) => {
            if (id.equals(SHACL.NodeShape)) return {};
            throw "Shape is not sh:NodeShape";
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
        .thenSome(extractProperty(cache, subclasses, apply))
        .map((fields) => ({ fields }));

    return multiple
        .and(checkTy, idLens, descriptionClassLens, fields)
        .map(([multiple, ...others]) =>
            multiple.map((xs) => <Shape>Object.assign({}, xs, ...others)),
        );
}

export type Shapes = {
    shapes: Shape[];
    lenses: Cache;
    subClasses: SubClasses;
};

/**
 * @param quads that should be used to extarct shapes from
 * @param [apply={}] optional apply functions that after extraction are applied to the parsed objects
 * @param [customClasses={}] lenses that are used to extract special objects types
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
        .execute(quads, [])
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

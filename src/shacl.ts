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

const { blankNode, literal, namedNode, quad } = new DataFactory();

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
 * WarningHandler receives a warning about a shape, and the property shape it
 * is about.
 */
export type WarningHandler = (message: string, property?: Term) => void;

let warningHandler: WarningHandler | undefined;

/**
 * setWarningHandler routes the warnings rdf-lens gives about shapes, such as a
 * deprecated sh:datatype, to a handler of your own, like a logger. Without one
 * they go to console.warn, and a handler that does nothing silences them.
 * Returns the handler it replaces, to put back afterwards.
 */
export function setWarningHandler(
    handler?: WarningHandler,
): WarningHandler | undefined {
    const previous = warningHandler;
    warningHandler = handler;
    return previous;
}

function warn(message: string, property?: Term) {
    if (warningHandler) warningHandler(message, property);
    else console.warn(message);
}

/**
 * Where names a property shape in warnings and errors, and holds its node.
 */
type Where = (() => string) & { property: Term };

/**
 * ShapeField describes a field/property in a SHACL shape, including its name, path, cardinality, and extraction lens
 */
export interface ShapeField {
    name: string;
    path: BasicLensM<Cont, Cont>;
    minCount?: number;
    maxCount?: number;
    extract: BasicLens<Cont, unknown>;
    /**
     * The sh:defaultValue node, used when the data has no value for this field.
     * It points into the shapes graph rather than the data, so extracting it
     * reads the default's own properties (`sh:defaultValue [ ex:age 95 ]`).
     */
    defaultValue?: Cont;
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

    const thenListExtract = RdfList.and(empty<Cont>()).map(
        ([terms, { quads }]) => terms.map((id) => ({ id, quads })),
    );
    const noListExtract = empty<Cont>().map((x) => [x]);

    // The default is extracted like any other value, but from the container it
    // was defined in: the shapes graph. So a literal goes through the same
    // datatype conversion, and a node through the same class lens, picking up
    // that shape's own defaults in turn.
    const defaults = thenListExtract
        .or(noListExtract)
        .asMulti()
        .thenAll(field.extract);
    const extractDefault = (ctx: LensContext): unknown[] | undefined =>
        field.defaultValue && defaults.execute(field.defaultValue, ctx);

    if (maxCount < 2) {
        return field.path.one(undefined).then(
            new BasicLens((x, ctx) => {
                if (x) {
                    return field.extract.execute(x, ctx);
                }

                const def = extractDefault(ctx);
                if (def && def.length > 0) {
                    return def[0];
                }

                if (minCount > 0) {
                    throw new LensError(
                        "Field is not defined and required",
                        ctx.lineage.slice(),
                    );
                } else {
                    return x;
                }
            }),
        );
    }

    return field.path
        .thenFlat(thenListExtract.or(noListExtract).asMulti())
        .thenAll(field.extract)
        .map((x) => x.filter((x) => x !== undefined))
        .map((xs, ctx) => (xs.length === 0 ? (extractDefault(ctx) ?? xs) : xs))
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

        // Each field on a lineage of its own, so an error in one does not
        // list the fields extracted before it
        return new BasicLens<Cont, { [label: string]: unknown }>((c, ctx) =>
            asField.execute(c, ctx.clone()),
        );
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
 * The term types each sh:nodeKind accepts.
 */
const NODE_KINDS: [Term, string[]][] = [
    [SHACL.IRI, ["NamedNode"]],
    [SHACL.BlankNode, ["BlankNode"]],
    [SHACL.Literal, ["Literal"]],
    [SHACL.BlankNodeOrIRI, ["BlankNode", "NamedNode"]],
    [SHACL.BlankNodeOrLiteral, ["BlankNode", "Literal"]],
    [SHACL.IRIOrLiteral, ["NamedNode", "Literal"]],
];

/**
 * The datatypes sh:codeType converts to, next to rdfl:Term for the term as is.
 */
const CODE_TYPES = [
    "string",
    "integer",
    "decimal",
    "float",
    "double",
    "boolean",
    "dateTime",
    "anyURI",
].map((x) => XSD.terms.custom(x));

/**
 * Rebuilds a term with this library's data factory, whichever parser made it.
 */
function normalizeTerm(term: Term): Term {
    if (term.termType === "NamedNode") return namedNode(term.value);
    if (term.termType === "BlankNode") return blankNode(term.value);
    if (term.termType !== "Literal") return term;
    if (!term.language) return literal(term.value, term.datatype);
    return literal(term.value, {
        language: term.language,
        direction: term.direction || undefined,
    });
}

// A scheme of two or more characters, so a Windows path like C:\data is not an
// IRI, followed by none of the characters IRIs exclude
const ABSOLUTE_IRI = /^[a-z][a-z0-9+.-]+:[^\s<>"{}|\\^`]+$/i;
// A host and port like localhost:8080, which would read as a scheme and a path
const HOST_PORT = /^[^:/?#]+:\d+(?:[/?#]|$)/;

/**
 * isAbsoluteIri tells whether a string holds an absolute IRI, to be read as one.
 */
function isAbsoluteIri(value: string): boolean {
    return ABSOLUTE_IRI.test(value) && !HOST_PORT.test(value);
}

/**
 * describeTerm names a term in warnings and errors.
 */
function describeTerm(term: Term): string {
    if (term.termType === "NamedNode") return "the IRI " + termToString(term);
    if (term.termType === "Literal") return "the literal " + termToString(term);
    if (term.termType === "BlankNode") return "a blank node";
    return "a " + term.termType;
}

/**
 * NodeKind checks terms against an sh:nodeKind, letting every term pass without
 * one (given is false then). problem tells what is wrong with an unknown node
 * kind.
 */
type NodeKind = {
    given: boolean;
    problem?: string;
    allows: (termType: string) => boolean;
    violation: (term: Term, ctx: LensContext, envKey?: string) => LensError;
};

function nodeKind(kindTerm: Term | undefined, where: () => string): NodeKind {
    const kind = kindTerm && NODE_KINDS.find(([k]) => kindTerm.equals(k));
    const allows = (termType: string) => !kind || kind[1].includes(termType);
    const problem =
        kindTerm && !kind
            ? `Unknown sh:nodeKind: ${where()} uses ${shortTerm(kindTerm)}, ` +
              `expected one of ${NODE_KINDS.map(([k]) => shortTerm(k)).join(", ")}`
            : undefined;

    const violation = (term: Term, ctx: LensContext, envKey?: string) => {
        const found = envKey
            ? `environment variable ${envKey}, which holds ` +
              JSON.stringify(term.value)
            : describeTerm(term);
        return new LensError(
            `Node kind violation: ${where()} expects ` +
                `${shortTerm(kindTerm!)}, found ${found}`,
            [
                {
                    name: "expected " + termToString(kindTerm!),
                    opts: "found " + term.termType,
                },
                ...ctx.lineage.slice(),
            ],
        );
    };

    return { given: !!kindTerm, problem, allows, violation };
}

/**
 * codeTypeOf reads sh:codeType (SHACL 1.2), what code receives from a property.
 */
const codeTypeOf: BasicLens<Cont, Term | undefined> = pred(
    SHACL.custom("codeType"),
)
    .one(undefined)
    .map((found) => found?.id);

/**
 * codeTypeProblem tells what is wrong with a code type, if anything: node kinds
 * describe the data, xsd:iri is no datatype, and a datatype rdf-lens does not
 * convert would hand code a term where it expects a value.
 */
function codeTypeProblem(
    codeType: Term,
    where: () => string,
): string | undefined {
    if (
        codeType.equals(RDFL.terms.Term) ||
        CODE_TYPES.some((x) => x.equals(codeType))
    ) {
        return;
    }

    const found = `Unsupported sh:codeType: ${where()} uses ${shortTerm(codeType)}`;
    if (codeType.equals(XSD.terms.custom("iri"))) {
        return `${found}, which is no datatype, use xsd:anyURI for an IRI`;
    }
    if (NODE_KINDS.some(([k]) => codeType.equals(k))) {
        return `${found}, a node kind, which belongs in sh:nodeKind`;
    }
    const supported = [...CODE_TYPES, RDFL.terms.Term].map(shortTerm);
    return `${found}, expected one of ${supported.join(", ")}`;
}

/**
 * extractTerm extracts the term at the path itself. The node kind constrains
 * its term type, convert turns it into what code receives: an xsd datatype
 * converts the value, xsd:anyURI makes an IRI of an IRI or an absolute IRI
 * string, rdfl:Term keeps the parsed term as is, and none rebuilds it with this
 * library's factory. An environment variable holds a string, so it becomes an
 * IRI when the kind allows one and it holds an absolute IRI, a literal
 * otherwise, converted with its own rdfl:datatype when there is no code type.
 * inspect sees every term from the data before it is converted.
 *
 * problem, a fault in the shape, is thrown once a value is extracted: throwing
 * while reading the shape would drop the whole node shape, leaving nothing to
 * point at the typo.
 */
function extractTerm(
    kind: NodeKind,
    convert: Term | undefined,
    where: () => string,
    inspect?: (term: Term) => void,
    problem?: string,
): BasicLens<Cont, unknown> {
    const env = envValue();

    return new BasicLens<Cont, unknown>((c, ctx) => {
        if (problem) throw new LensError(problem, ctx.lineage.slice());

        let term = c.id;
        let envKey: string | undefined;
        let to = convert;
        if (isEnvVariable(c)) {
            const { key, value, dt } = env.execute(c, ctx);
            envKey = key;
            term =
                kind.given && kind.allows("NamedNode") && isAbsoluteIri(value)
                    ? namedNode(value)
                    : literal(value);
            to = convert || dt;
        }
        if (!kind.allows(term.termType)) {
            throw kind.violation(term, ctx, envKey);
        }
        if (!envKey && to && !to.equals(RDFL.terms.Term)) {
            inspect?.(term);
        }

        if (!to) return normalizeTerm(term);
        // The term untouched, quads and all, not a rebuilt copy of it
        if (to.equals(RDFL.terms.Term)) return term;
        if (to.equals(XSD.terms.custom("anyURI"))) {
            if (term.termType === "NamedNode") return normalizeTerm(term);
            if (term.termType === "Literal" && isAbsoluteIri(term.value)) {
                return namedNode(term.value);
            }
            throw new LensError(
                `Expected an IRI: ${where()} was given ${describeTerm(term)}`,
                [
                    { name: "found", opts: termToString(term) },
                    ...ctx.lineage.slice(),
                ],
            );
        }
        return dataTypeToExtract(to, term);
    });
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
 * isEnvVariable tells whether a node is typed rdfl:EnvVariable.
 */
function isEnvVariable({ id, quads }: Cont): boolean {
    return quads.some(
        (q) =>
            q.subject.equals(id) &&
            q.predicate.equals(RDF.terms.type) &&
            q.object.equals(RDFL.terms.EnvVariable),
    );
}

/**
 * envValue resolves an rdfl:EnvVariable node to its key and the string it
 * holds, together with the rdfl:datatype the node itself asks for, if any.
 * Throws if variable is missing and no default is set.
 */
type EnvValue = { key: string; value: string; dt?: Term };

function envValue(): BasicLens<Cont, EnvValue> {
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
        .map(([, { key }, { defaultValue }, { dt }], ctx) => {
            const value = process.env[key] || defaultValue;

            if (value) {
                return { key, value, dt };
            } else {
                throw new LensError("ENV and default are not set", [
                    { name: "Env Key", opts: key },
                    ...ctx.lineage,
                ]);
            }
        });
}

/**
 * envTerm resolves an rdfl:EnvVariable node to the term that stands in for it:
 * an IRI when its rdfl:datatype is xsd:anyURI or xsd:iri, a literal of its
 * rdfl:datatype otherwise, and a string literal without one, so envReplace
 * always puts a term in the data.
 * Throws if variable is missing and no default is set.
 */
function envTerm(): BasicLens<Cont, { key: string; term: Term }> {
    return envValue().map(({ key, value, dt }) => {
        if (dt?.termType !== "NamedNode") return { key, term: literal(value) };
        if (
            dt.equals(XSD.terms.custom("anyURI")) ||
            dt.equals(XSD.terms.custom("iri"))
        ) {
            return { key, term: namedNode(value) };
        }
        return { key, term: literal(value, dt) };
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
        .then(
            envTerm()
                .map((x) => x.term)
                .and(empty<Cont>().map((x) => x.id)),
        )
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
 * extractLeaf creates a lens that extracts a leaf value from a node, resolving it as an environment variable when it is one, otherwise converting by datatype.
 * inspect is handed every term from the data before it is converted.
 */
function extractLeaf(
    datatype: Term,
    inspect?: (term: Term) => void,
): BasicLens<Cont, unknown> {
    const env = envValue();
    return new BasicLens<Cont, unknown>((c, ctx) => {
        if (isEnvVariable(c)) {
            const { value } = env.execute(c, ctx);
            return dataTypeToExtract(datatype, literal(value));
        }
        inspect?.(c.id);
        return dataTypeToExtract(datatype, c.id);
    });
}

const PREFIXES: [string, string][] = [
    ["http://www.w3.org/2001/XMLSchema#", "xsd:"],
    ["http://www.w3.org/ns/shacl#", "sh:"],
    [RDFL.custom(""), "rdfl:"],
];

function shortTerm(term: Term): string {
    const prefix = PREFIXES.find(([ns]) => term.value.startsWith(ns));
    return prefix
        ? prefix[1] + term.value.slice(prefix[0].length)
        : termToString(term);
}

/**
 * converts tells whether rdf-lens converts values of a datatype, rather than
 * handing back the term as is.
 */
function converts(datatype: Term): boolean {
    const probe = literal("");
    return dataTypeToExtract(datatype, probe) !== probe;
}

/**
 * iriAdvice tells what replaces sh:datatype xsd:iri for the term it was given:
 * only that term shows which replacement extracts the same value.
 */
function iriAdvice(where: string, term: Term): string {
    const start = `rdf-lens: ${where} uses sh:datatype xsd:iri, which is deprecated`;
    if (term.termType === "Literal") {
        return (
            `${start}, and was given ${describeTerm(term)}, which it reads ` +
            "as an IRI. Use sh:nodeKind sh:IRIOrLiteral and sh:codeType " +
            "xsd:anyURI instead, it extracts the same IRI from an absolute IRI."
        );
    }
    if (term.termType === "BlankNode") {
        return (
            `${start}, and was given a blank node, which it turns into an IRI ` +
            "named after the blank node's label. Use sh:nodeKind " +
            "sh:BlankNodeOrIRI instead, it extracts the blank node itself."
        );
    }
    return `${start}: use sh:nodeKind sh:IRI instead, it extracts the same term.`;
}

/**
 * checkDatatype returns a check, to run on every term from the data, that warns
 * when sh:datatype is used for more than literals: xsd:iri, which is
 * deprecated, and a converting datatype such as xsd:string handed an IRI or a
 * blank node, which belongs in sh:nodeKind with sh:codeType. It warns once
 * per term type, with the replacement for that type.
 */
function checkDatatype(
    datatype: Term,
    where: Where,
    hasNodeKind: boolean,
): ((term: Term) => void) | undefined {
    const iri = datatype.equals(XSD.terms.custom("iri"));
    // anyURI is about IRIs by intent, and a datatype rdf-lens does not convert
    // hands the term back as is, which sh:codeType rdfl:Term asks for
    if (
        !iri &&
        (datatype.equals(XSD.terms.custom("anyURI")) || !converts(datatype))
    ) {
        return;
    }

    const dt = shortTerm(datatype);
    const warned = new Set<string>();
    return (term) => {
        if (warned.has(term.termType)) return;
        if (!iri && term.termType === "Literal") return;
        warned.add(term.termType);

        if (iri) return warn(iriAdvice(where(), term), where.property);

        let kind = "sh:IRIOrLiteral";
        let only = "sh:IRI if only IRIs are expected";
        if (term.termType === "BlankNode") {
            kind = "sh:BlankNodeOrLiteral";
            only = "sh:BlankNode if only blank nodes are expected";
        }
        const fix = hasNodeKind
            ? `Use sh:codeType ${dt} instead of sh:datatype ${dt}, ` +
              "sh:datatype only describes literals"
            : `Use sh:nodeKind ${kind} (or ${only}) and sh:codeType ${dt}`;
        warn(
            `rdf-lens: ${where()} declares sh:datatype ${dt} but was given ` +
                `${describeTerm(term)}, which it converts by value. ${fix}, ` +
                "the value stays the same.",
            where.property,
        );
    };
}

/**
 * checkCodeType returns a check, to run on every term from the data, that warns
 * once when a code type without sh:nodeKind converts a blank node, which only
 * has its label to convert.
 */
function checkCodeType(
    codeType: Term,
    where: Where,
): ((term: Term) => void) | undefined {
    // anyURI rejects blank nodes itself
    if (codeType.equals(XSD.terms.custom("anyURI")) || !converts(codeType)) {
        return;
    }

    let warned = false;
    return (term) => {
        if (warned || term.termType !== "BlankNode") return;
        warned = true;
        warn(
            `rdf-lens: ${where()} converts a blank node with sh:codeType ` +
                `${shortTerm(codeType)}, which reads its label. Add ` +
                "sh:nodeKind, such as sh:IRIOrLiteral, to reject blank nodes.",
            where.property,
        );
    };
}

/**
 * describeProperty names a property in warnings and errors, with the target
 * class of its node shape, as a path alone may be shared by many shapes.
 */
const describeProperty: BasicLens<Cont, string> = pred(
    SHACL.custom("codeIdentifier"),
)
    .one(undefined)
    .and(
        pred(SHACL.name).one(undefined),
        pred(SHACL.path).one(undefined),
        invPred(SHACL.property)
            .thenFlat(pred(SHACL.targetClass))
            .one(undefined),
    )
    .map(([code, name, path, clazz]) => {
        const n = (code || name)?.id.value;
        return (
            (n ? "property " + JSON.stringify(n) : "a property") +
            (path ? " (path " + termToString(path.id) : " (") +
            (clazz ? ", shape " + termToString(clazz.id) : "") +
            ")"
        );
    });

/**
 * describeShapeProperty names a property shape as rdf-lens warnings and errors
 * do: its name, its path and the target class of its node shape.
 */
export function describeShapeProperty(property: Term, quads: Quad[]): string {
    return describeProperty.execute({ id: property, quads });
}

/**
 * once computes a value the first time it is asked for.
 */
function once<T>(fn: () => T): () => T {
    let done = false;
    let value: T;
    return () => {
        if (!done) {
            value = fn();
            done = true;
        }
        return value;
    };
}

type Extract = { extract: ShapeField["extract"] };

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

    const nameLens = field(SHACL.custom("codeIdentifier"), "name").or(
        field(SHACL.name, "name"),
    );
    const minCount = optionalField(SHACL.minCount, "minCount", (x) => +x);
    const maxCount = optionalField(SHACL.maxCount, "maxCount", (x) => +x);

    // A nested object, built with the shape of its class, under the node kind
    const clazzLens = (where: Where): BasicLens<Cont, Extract> =>
        field(SHACL.class, "clazz")
            .and(pred(SHACL.nodeKind).one(undefined))
            .map(([{ clazz: expected_class }, kindTerm]) => {
                const kind = nodeKind(kindTerm?.id, where);
                if (kind.problem)
                    warn("rdf-lens: " + kind.problem, where.property);

                return {
                    extract: new BasicLens<Cont, unknown>(
                        ({ id, quads }, ctx) => {
                            if (kind.problem) {
                                throw new LensError(
                                    kind.problem,
                                    ctx.lineage.slice(),
                                );
                            }
                            if (!kind.allows(id.termType)) {
                                throw kind.violation(id, ctx);
                            }
                            // We did not find a type, so use the expected class lens
                            const lens = cache[expected_class];
                            if (!lens) {
                                throw new LensError(
                                    "Tried extracting class, but no shape was defined",
                                    [
                                        {
                                            name:
                                                "Found type: " + expected_class,
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
                        },
                    ).named("extracting class", expected_class),
                };
            });

    // Keep the container, not just the term: the default may be a node whose
    // properties live in the shapes graph, and those quads travel with it.
    const defaultValueLens: BasicLens<Cont, { defaultValue?: Cont }> = pred(
        SHACL.defaultValue,
    )
        .one(undefined)
        .map((defaultValue) => (defaultValue ? { defaultValue } : {}));

    // sh:nodeKind constrains the term, sh:codeType converts it, either alone
    // is enough. Without sh:codeType, sh:datatype converts, under the kind:
    // `sh:nodeKind sh:Literal; sh:datatype xsd:integer` still gives a number.
    // Without either, sh:datatype converts any term, as it always did.
    const leafLens = (
        where: Where,
        codeType?: Term,
    ): BasicLens<Cont, Extract> =>
        pred(SHACL.nodeKind)
            .one(undefined)
            .and(pred(SHACL.datatype).one(undefined))
            .map(([kindTerm, datatypeTerm], ctx) => {
                const datatype = datatypeTerm?.id;

                if (!kindTerm && !codeType) {
                    if (!datatype) {
                        throw new LensError(
                            "Expected sh:class, sh:nodeKind, sh:codeType or sh:datatype, found none",
                            ctx.lineage.slice(),
                        );
                    }
                    return {
                        extract: extractLeaf(
                            datatype,
                            checkDatatype(datatype, where, false),
                        ),
                    };
                }

                const kind = nodeKind(kindTerm?.id, where);
                const problem =
                    kind.problem ??
                    (codeType ? codeTypeProblem(codeType, where) : undefined);
                if (problem) warn("rdf-lens: " + problem, where.property);

                // sh:datatype describes the data and sh:codeType what code
                // receives, so the two may differ without a warning
                let convert = codeType;
                let inspect =
                    codeType && !kindTerm
                        ? checkCodeType(codeType, where)
                        : undefined;
                if (!codeType && datatype?.equals(XSD.terms.custom("iri"))) {
                    // Not an error like sh:codeType xsd:iri: sh:datatype
                    // xsd:iri was how rdf-lens asked for an IRI
                    warn(
                        `rdf-lens: ${where()} uses sh:datatype xsd:iri next to ` +
                            "sh:nodeKind, which is deprecated: use sh:codeType " +
                            "xsd:anyURI instead, or leave it out when sh:nodeKind " +
                            "only allows IRIs.",
                        where.property,
                    );
                    convert = XSD.terms.custom("anyURI");
                } else if (!codeType && datatype) {
                    convert = datatype;
                    inspect = checkDatatype(datatype, where, true);
                }

                return {
                    extract: extractTerm(
                        kind,
                        convert,
                        where,
                        inspect,
                        problem,
                    ),
                };
            });

    return new BasicLens<Cont, ShapeField>((c, ctx) => {
        // Only worked out for a warning or an error, as it looks at the
        // shape around the property
        const where: Where = Object.assign(
            once(() => describeProperty.execute(c)),
            { property: c.id },
        );

        // SHACL 1.2: tools that would derive the type from the constraints
        // use sh:codeType instead, so it goes before the nested object
        // sh:class would build
        const codeType = codeTypeOf.execute(c, ctx.clone());
        const extract = codeType
            ? leafLens(where, codeType)
            : clazzLens(where).or(leafLens(where));

        return pathLens
            .and(nameLens, minCount, maxCount, defaultValueLens, extract)
            .map((xs) => <ShapeField>Object.assign({}, ...xs))
            .execute(c, ctx);
    });
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

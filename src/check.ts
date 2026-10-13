import { Quad, Quad_Object, Term } from "@rdfjs/types";
import { DataFactory } from "rdf-data-factory";
import { RDF, XSD } from "@treecg/types";
import { BasicLens, Cont, empty, LensError } from "./lens";
import { RDFL, SHACL } from "./ontology";
import {
    describeShapeProperty,
    extractShape,
    extractShapes,
    setWarningHandler,
} from "./shacl";

/**
 * Finding is something checkShapes found: a warning about a deprecated shape,
 * or an error that makes reading a shape or extracting data fail.
 */
export type Finding = {
    level: "warning" | "error";
    message: string;
    /** The property shape it is about, when known */
    property?: Term;
    /** The data node being extracted when it was found */
    focus?: Term;
};

/**
 * CheckReport lists the findings of checkShapes, and what it looked at.
 */
export type CheckReport = {
    findings: Finding[];
    /** Node shapes with a target class */
    shapes: number;
    /** Data nodes extracted with those shapes */
    focusNodes: number;
    /** Classes used with sh:class that no shape describes, so not checked */
    unchecked: Term[];
};

const df = new DataFactory();

// The target class of the node shapes a property is read in on its own
const PROBE = df.namedNode("https://w3id.org/rdf-lens/ontology#CheckProbe");

// Classes extractShapes provides lenses for itself
const BUILT_IN = [RDFL.CBD, RDFL.PathLens, RDFL.Context, RDFL.TypedExtract];

// Warned about when the shape is read, but certain to fail once the property
// is given a value
const FAILS = /^rdf-lens: (Unsupported sh:codeType|Unknown sh:nodeKind):/;

/**
 * checkShapes reads the SHACL shapes in quads the way extractShapes does, and
 * extracts every node in quads typed with one of their target classes,
 * collecting what rdf-lens warns about and what fails. Without data it still
 * finds the shapes that cannot be read, unsupported code types and node kinds,
 * and sh:datatype xsd:iri; with data it also finds sh:datatype converting IRIs
 * or blank nodes, and values that do not fit their shape.
 *
 * A class used with sh:class that no shape in quads describes, like a class a
 * framework provides a lens for, is taken as is, and listed as unchecked.
 */
export function checkShapes(quads: Quad[]): CheckReport {
    const findings: Finding[] = [];
    let focus: Term | undefined;
    const previous = setWarningHandler((message, property) =>
        findings.push({
            level: FAILS.test(message) ? "error" : "warning",
            message,
            property,
            focus,
        }),
    );

    try {
        const objects = (subject: Term | undefined, predicate: Term) =>
            quads
                .filter(
                    (q) =>
                        (!subject || q.subject.equals(subject)) &&
                        q.predicate.equals(predicate),
                )
                .map((q) => q.object);

        const nodeShapes = unique(
            quads
                .filter(
                    (q) =>
                        q.predicate.equals(RDF.terms.type) &&
                        q.object.equals(SHACL.NodeShape),
                )
                .map((q) => q.subject),
        ).filter((shape) => objects(shape, SHACL.targetClass).length > 0);

        const described = new Set([
            ...BUILT_IN,
            ...objects(undefined, SHACL.targetClass).map((x) => x.value),
        ]);
        const unchecked = unique(objects(undefined, SHACL.class)).filter(
            (clazz) =>
                clazz.termType === "NamedNode" && !described.has(clazz.value),
        );
        const opaque: { [clazz: string]: BasicLens<Cont, unknown> } = {};
        for (const clazz of unchecked) {
            opaque[clazz.value] = empty<Cont>().map(({ id }) => id);
        }

        const shapes = extractShapes(quads, {}, opaque);

        // extractShapes skips a node shape it cannot read, and stops at the
        // first property it cannot read: read each property on its own, in a
        // node shape of its own, to tell what is wrong with every one of them
        const read = new Set(shapes.shapes.map((shape) => shape.id));
        const readShape = extractShape(shapes.lenses, shapes.subClasses, {});
        for (const shape of nodeShapes) {
            if (read.has(shape.value)) continue;
            const targets = objects(shape, SHACL.targetClass)
                .map(termToString)
                .join(", ");
            for (const property of unique(objects(shape, SHACL.property))) {
                const probe = df.blankNode();
                try {
                    readShape.execute({
                        id: probe,
                        quads: [
                            ...quads,
                            df.quad(probe, RDF.terms.type, SHACL.NodeShape),
                            df.quad(probe, SHACL.targetClass, PROBE),
                            df.quad(
                                probe,
                                SHACL.property,
                                <Quad_Object>property,
                            ),
                        ],
                    });
                } catch (ex) {
                    // Name what a property lacks, rather than how its lens
                    // failed
                    const missing = missingFrom(property, objects);
                    const reason = missing
                        ? `${describeShapeProperty(property, quads)} has no ${missing}`
                        : `${describeShapeProperty(property, quads)}: ${describeError(ex)}`;
                    findings.push({
                        level: "error",
                        message: `The shape for ${targets} cannot be read: ${reason}`,
                        property,
                    });
                }
            }
        }

        let focusNodes = 0;
        for (const clazz of unique(shapes.shapes.map((shape) => shape.ty))) {
            for (const node of instancesOf(clazz, quads, shapes.subClasses)) {
                focusNodes += 1;
                focus = node;
                try {
                    shapes.lenses[clazz.value].execute({ id: node, quads });
                } catch (ex) {
                    findings.push({
                        level: "error",
                        message: describeError(ex),
                        focus: node,
                    });
                }
            }
        }
        focus = undefined;

        // sh:datatype xsd:iri only warns once it is given a term, as the
        // replacement depends on it, so name what replaces it when no data
        // reached the property
        const warned = new Set(
            findings.flatMap((x) => (x.property ? [key(x.property)] : [])),
        );
        for (const property of unique(objects(undefined, SHACL.property))) {
            const datatypes = objects(property, SHACL.datatype);
            if (
                warned.has(key(property)) ||
                !datatypes.some((x) => x.equals(XSD.terms.custom("iri"))) ||
                objects(property, SHACL.nodeKind).length > 0 ||
                objects(property, SHACL.custom("codeType")).length > 0
            ) {
                continue;
            }
            findings.push({
                level: "warning",
                message:
                    `rdf-lens: ${describeShapeProperty(property, quads)} uses ` +
                    "sh:datatype xsd:iri, which is deprecated: use sh:nodeKind " +
                    "sh:IRI when it holds IRIs, or sh:nodeKind sh:IRIOrLiteral " +
                    "and sh:codeType xsd:anyURI when it also holds strings " +
                    "with an IRI.",
                property,
            });
        }

        return {
            findings: uniqueFindings(findings),
            shapes: nodeShapes.length,
            focusNodes,
            unchecked,
        };
    } finally {
        setWarningHandler(previous);
    }
}

/**
 * instancesOf finds the nodes typed with a class or one of its subclasses.
 */
function instancesOf(
    clazz: Term,
    quads: Quad[],
    subClasses: { [clazz: string]: string },
): Term[] {
    const isA = (ty: string) => {
        const seen = new Set<string>();
        for (let c: string | undefined = ty; c; c = subClasses[c]) {
            if (c === clazz.value) return true;
            if (seen.has(c)) return false;
            seen.add(c);
        }
        return false;
    };
    return unique(
        quads
            .filter(
                (q) =>
                    q.predicate.equals(RDF.terms.type) && isA(q.object.value),
            )
            .map((q) => q.subject),
    );
}

/**
 * missingFrom tells what a property shape lacks for rdf-lens to read it, if
 * anything: a path, a name, and how to extract its values.
 */
function missingFrom(
    property: Term,
    objects: (subject: Term, predicate: Term) => Term[],
): string | undefined {
    const has = (...predicates: Term[]) =>
        predicates.some((p) => objects(property, p).length > 0);
    if (!has(SHACL.path)) return "sh:path";
    if (!has(SHACL.name, SHACL.custom("codeIdentifier"))) {
        return "sh:name or sh:codeIdentifier";
    }
    if (
        !has(
            SHACL.class,
            SHACL.nodeKind,
            SHACL.custom("codeType"),
            SHACL.datatype,
        )
    ) {
        return "sh:class, sh:nodeKind, sh:codeType or sh:datatype";
    }
}

/**
 * describeError tells what went wrong, with the fields it happened in.
 */
function describeError(ex: unknown): string {
    // A lens with alternatives throws what each of them threw; a missing
    // alternative can fail with a TypeError that tells nothing
    if (Array.isArray(ex)) {
        const flat = ex.flat(Infinity);
        const lensErrors = flat.filter((x) => x instanceof LensError);
        const errors = lensErrors.length > 0 ? lensErrors : flat;
        return [...new Set(errors.map(describeError))].join("; or ");
    }
    if (!(ex instanceof LensError)) {
        return ex instanceof Error ? ex.message : String(ex);
    }
    let out = ex.message;
    const found = ex.lineage.find((x) => x.name.startsWith("found"));
    if (found) {
        const count = typeof found.opts === "number" ? " " + found.opts : "";
        out += ` (${found.name.replace(/:\s*/, " ").trim()}${count})`;
    }
    const fields = ex.lineage
        .filter((x) => x.name === "processing field")
        .map((x) => (<{ name?: string }>x.opts)?.name)
        .filter((x) => x !== undefined)
        .map((x) => JSON.stringify(x));
    if (fields.length > 0 && !out.includes("property ")) {
        out += `, in field ${fields.join(" > ")}`;
    }
    return out;
}

function termToString(term: Term): string {
    if (term.termType === "NamedNode") return "<" + term.value + ">";
    if (term.termType === "BlankNode") return "_:" + term.value;
    return JSON.stringify(term.value);
}

function key(term: Term): string {
    return term.termType + " " + term.value;
}

function unique<T extends Term>(terms: T[]): T[] {
    const seen = new Set<string>();
    return terms.filter((term) => {
        if (seen.has(key(term))) return false;
        seen.add(key(term));
        return true;
    });
}

function uniqueFindings(findings: Finding[]): Finding[] {
    const seen = new Set<string>();
    return findings.filter((finding) => {
        const k = [
            finding.level,
            finding.message,
            finding.focus ? key(finding.focus) : "",
        ].join("\n");
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

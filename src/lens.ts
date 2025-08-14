import type { Quad, Term } from "@rdfjs/types";

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
 * Type alias for a container with an ID and quads.
 */
export type Cont<Q = Term> = { id: Q; quads: Quad[] };

export type Lineage = {
    name: string;
    opts: unknown | undefined;
};

export class LensError extends Error {
    lineage: Lineage[];

    constructor(message: string, lineage: Lineage[]) {
        super(message);
        this.message = message;
        this.lineage = lineage;
    }
}

/**
 * Per-run context for tracking lens state
 */
export interface LensContext {
    stateMap: Map<BasicLens<unknown, unknown>, unknown>;
    lineage: Lineage[];
    clone(): this;
}

/**
 * Create a fresh context for a lens execution run
 */
export function createContext(): LensContext {
    const ctx = {
        stateMap: new Map(),
        lineage: [],
    };
    const clone = () => ({
        clone,
        stateMap: ctx.stateMap,
        lineage: ctx.lineage.slice(),
    });

    return Object.assign(ctx, { clone });
}

/**
 * Basic lens class for handling data transformations.
 */
export class BasicLens<C, T> {
    /**
     * Internal execution function for the lens.
     */
    _exec: (container: C, ctx: LensContext) => T;

    /**
     * Unique index for the lens.
     */
    index: number;

    /**
     * Creates a new BasicLens instance.
     * @param execute - Execution function for the lens.
     */
    constructor(execute: (container: C, ctx: LensContext) => T) {
        this._exec = execute;
    }

    named(
        name: string,
        opts?: unknown,
        cb?: (c: C) => unknown,
    ): BasicLens<C, T> {
        return new BasicLens<C, T>((c, ctx) => {
            let extras = asList(opts) || [];
            if (cb) {
                extras = [...extras, ...asList(cb(c))];
            }
            ctx.lineage.push({ name, opts: deconstructList(extras) });
            return this.execute(c, ctx);
        });
    }

    /**
     * Converts a lens returning an array into a multi-valued lens.
     * @returns Multi-valued lens for handling multiple results.
     */
    asMulti(): T extends unknown[] ? BasicLensM<C, T[number]> : never {
        return <T extends unknown[] ? BasicLensM<C, T[number]> : never>(
            new BasicLensM((c, ctx) => {
                const out = this.execute(c, ctx);
                return <T extends unknown[] ? unknown[] : never>out;
            })
        );
    }

    /**
     * Combines this lens with other lenses, returning a tuple of their results.
     * @param and - Additional lenses to combine with this one.
     * @returns A lens producing [thisResult, ...otherResults].
     */
    and<F extends unknown[]>(
        ...and: { [K in keyof F]: BasicLens<C, F[K]> }
    ): BasicLens<C, [T, ...{ [K in keyof F]: F[K] }]> {
        return <BasicLens<C, [T, ...{ [K in keyof F]: F[K] }]>>(
            new BasicLens((c, ctx) => {
                const a = this.execute(c, ctx);
                const rest: unknown[] = and.map((x) => x.execute(c, ctx));
                return [a, ...rest];
            })
        );
    }

    /**
     * Aggregates results from this and other lenses, ignoring failures.
     * @param others - Other lenses whose results are collected.
     * @returns A multi-valued lens with all successful results.
     */
    orM(...others: BasicLens<C, T>[]): BasicLensM<C, T> {
        return new BasicLensM((c, ctx) => {
            const all = [this, ...others];
            return all.flatMap((x) => {
                try {
                    return [x.execute(c, ctx.clone())];
                } catch (ex: unknown) {
                    return [];
                }
            });
        });
    }

    /**
     * Returns the first successful result from this or fallback lenses.
     * @param others - Fallback lenses to attempt on failure.
     * @returns A lens that returns the first successful output or throws.
     */
    or(...others: BasicLens<C, T>[]): BasicLens<C, T> {
        return new BasicLens((c, ctx) => {
            const errors = [];
            try {
                return this.execute(c, ctx);
            } catch (ex: unknown) {
                errors.push(ex);
                for (let i = 0; i < others.length; i++) {
                    try {
                        return others[i].execute(c, ctx.clone());
                    } catch (ex: unknown) {
                        errors.push(ex);
                    }
                }
            }
            throw errors;
        });
    }

    /**
     * Transforms the result of this lens with a mapping function.
     * @param fn - Function applied to the lens result.
     * @returns A lens producing the transformed result.
     */
    map<F>(fn: (t: T, ctx: LensContext) => F): BasicLens<C, F> {
        return new BasicLens((c, ctx) => {
            const a = this.execute(c, ctx);
            return fn(a, ctx);
        });
    }

    /**
     * Chains this lens with another lens.
     * @param next - Next lens to apply to this lens's result.
     * @returns A composed lens representing the sequential operation.
     */
    then<F>(next: BasicLens<T, F>): BasicLens<C, F> {
        return new BasicLens((c, ctx) => {
            const a = this.execute(c, ctx);
            return next.execute(a, ctx);
        });
    }

    /**
     * Execute the lens using a per-run context.
     * @param container - Input container for the lens
     * @param ctx - Optional context; a new one is created if not provided
     * @returns Result of applying the lens
     */
    execute(container: C, ctx: LensContext = createContext()): T {
        return this._exec(container, ctx);
    }
}

function deconstructList<T>(x: T[]): T[] | T {
    if (x.length == 1) {
        return x[0];
    }
    return x;
}

function asList<T>(x: T | T[]): T[] {
    if (Array.isArray(x)) return x;
    return [x];
}
/**
 * Multi-valued lens class for handling arrays of data.
 */
export class BasicLensM<C, T> extends BasicLens<C, T[]> {
    named(
        name: string,
        opts?: unknown,
        cb?: (c: C) => unknown,
    ): BasicLensM<C, T> {
        return new BasicLensM<C, T>((c, ctx) => {
            let extras = asList(opts) || [];
            if (cb) {
                extras = [...extras, ...asList(cb(c))];
            }
            ctx.lineage.push({ name, opts: deconstructList(extras) });
            return this.execute(c, ctx);
        });
    }
    /**
     * Returns the first element of the result array or a default value.
     * @param def - Default value if no result exists.
     * @returns A lens producing the first element or default.
     */
    one<D = T>(def?: D): BasicLens<C, T | D> {
        return new BasicLens((c, ctx) => {
            const qs = this.execute(c, ctx);
            return qs[0] || def!;
        });
    }

    /**
     * Returns the first element of the result array or throws if empty.
     * @returns A lens producing a single element.
     * @throws Error if the result array is empty.
     */
    expectOne(): BasicLens<C, T> {
        return new BasicLens((c, ctx) => {
            const qs = this.execute(c, ctx);
            if (qs.length < 1)
                throw new LensError(
                    "Expected one, found none",
                    ctx.lineage.slice(),
                );
            return qs[0];
        });
    }

    /**
     * Applies a lens to each element and collects successful results.
     * @param next - Lens to apply to each element.
     * @returns A multi-valued lens of transformed elements.
     */
    thenAll<F>(next: BasicLens<T, F>): BasicLensM<C, F> {
        return new BasicLensM((c, ctx) => {
            const qs = this.execute(c, ctx.clone());
            return qs.map((x) => next.execute(x, ctx.clone()));
        });
    }

    /**
     * Alias for thenAll.
     */
    thenSome<F>(next: BasicLens<T, F>): BasicLensM<C, F> {
        return new BasicLensM((c, ctx) => {
            const qs = this.execute(c, ctx.clone());
            return qs.flatMap((x) => {
                try {
                    const o = next.execute(x, ctx.clone());
                    return [o];
                } catch (ex: unknown) {
                    // TODO: at least something should happend with these errors
                    return [];
                }
            });
        });
    }

    /**
     * Applies a multi-valued lens to each element and flattens the results.
     * @param next - Multi-valued lens to apply.
     * @returns A multi-valued lens of flattened results.
     */
    thenFlat<F>(next: BasicLensM<T, F>): BasicLensM<C, F> {
        return new BasicLensM((c, ctx) => {
            const qs = this.execute(c, ctx.clone());
            return qs.flatMap((x) => next.execute(x, ctx.clone()));
        });
    }

    /**
     * Maps a function over all elements in the result array.
     * @param fn - Function to transform each element.
     * @returns A multi-valued lens of transformed elements.
     */
    mapAll<F>(fn: (t: T, ctx: LensContext) => F): BasicLensM<C, F> {
        return new BasicLensM((c, ctx) => {
            const qs = this.execute(c, ctx);
            return qs.map((x) => fn(x, ctx));
        });
    }

    /**
     * Combines results from this multi-lens with other multi-lenses.
     * @param others - Additional multi-valued lenses to combine.
     * @returns A multi-valued lens of concatenated results.
     */
    orAll(...others: BasicLensM<C, T>[]): BasicLensM<C, T> {
        return new BasicLensM((c, ctx) => {
            const out = [];
            try {
                out.push(...this.execute(c, ctx.clone()));
            } catch (ex: unknown) {
                // TODO: at least something should happend with these errors
            }
            for (let i = 0; i < others.length; i++) {
                try {
                    out.push(...others[i].execute(c, ctx.clone()));
                } catch (ex: unknown) {
                    // TODO: at least something should happend with these errors
                }
            }

            return out;
        });
    }

    /**
     * Filters the result array based on a predicate.
     * @param fn - Predicate function to test elements.
     * @returns A multi-valued lens of filtered elements.
     */
    filter(fn: (object: T) => boolean): BasicLensM<C, T> {
        return new BasicLensM((c, ctx) => {
            return this.execute(c, ctx).filter(fn);
        });
    }

    /**
     * Reduces the result array using an accumulator lens.
     * @param lens - Lens applied at each reduction step.
     * @param start - Initial accumulator lens.
     * @returns A composed lens producing the final accumulated value.
     */
    reduce<F>(
        lens: BasicLens<[T, F], F>,
        start: BasicLens<C, F>,
    ): BasicLens<C, F> {
        return new BasicLens((c, ctx) => {
            const st = this.and(start).map(([ts, f]) => {
                return ts.reduce((acc, v) => lens.execute([v, acc], ctx), f);
            });

            return st.execute(c, ctx);
        });
    }
}

/**
 * Lens for traversing outgoing edges with an optional predicate filter.
 * @param pred - Predicate to match for outgoing edges.
 * @returns A multi-valued lens over matching Cont nodes.
 */
export function pred(pred?: Term): BasicLensM<Cont, Cont> {
    return new BasicLensM<Cont, Cont>(({ quads, id }) => {
        const out = quads.filter(
            (q) => q.subject.equals(id) && (!pred || q.predicate.equals(pred)),
        );
        return out.map((q) => ({ quads, id: q.object }));
    }).named("pred", pred && termToString(pred));
}

/**
 * Lens for traversing incoming edges with an optional predicate filter.
 * @param pred - Predicate to match for incoming edges.
 * @returns A multi-valued lens over matching Cont nodes.
 */
export function invPred(pred?: Term): BasicLensM<Cont, Cont> {
    return new BasicLensM<Cont, Cont>(({ quads, id }) => {
        const out = quads.filter(
            (q) => q.object.equals(id) && (!pred || q.predicate.equals(pred)),
        );
        return out.map((q) => ({ quads, id: q.subject }));
    }).named("invPred", pred && termToString(pred));
}

/**
 * Lens returning triple containers matching a subject/predicate.
 * @param pred - Predicate to filter triples.
 * @returns Multi-valued lens over Cont<Quad>.
 */
export function predTriple(pred?: Term): BasicLensM<Cont, Cont<Quad>> {
    return new BasicLensM<Cont, Cont<Quad>>(({ quads, id }) => {
        const out = quads.filter(
            (q) => q.subject.equals(id) && (!pred || q.predicate.equals(pred)),
        );
        return out.map((q) => ({ quads, id: q }));
    }).named("predTriple");
}

/**
 * Deduplicates Cont elements based on term type and value.
 * @returns A multi-valued lens of unique Cont elements.
 */
export function unique(): BasicLensM<Cont[], Cont> {
    return new BasicLensM<Cont[], Cont>((qs) => {
        const literals: { [id: string]: Cont } = {};
        const named: { [id: string]: Cont } = {};
        const blank: { [id: string]: Cont } = {};
        for (const q of qs) {
            const ty = q.id.termType;
            if (ty === "Literal") literals[q.id.value] = q;
            if (ty === "NamedNode") named[q.id.value] = q;
            if (ty === "BlankNode") blank[q.id.value] = q;
        }
        const out = [];
        out.push(...Object.values(literals));
        out.push(...Object.values(named));
        out.push(...Object.values(blank));
        return out;
    }).named("unique");
}

/**
 * Extracts all subjects from a set of quads into Cont containers.
 * @returns Multi-valued lens over unique subjects.
 */
export function subjects(): BasicLensM<Quad[], Cont> {
    return new BasicLensM<Quad[], Cont>((quads) => {
        return quads.map((x) => ({ id: x.subject, quads }));
    }).named("subjects");
}

/**
 * Matches quads based on optional subject, predicate, and object patterns.
 * @param subject - Term to match as subject.
 * @param predicate - Term to match as predicate.
 * @param object - Term to match as object.
 * @returns A multi-valued lens over matching Quad Cont containers.
 */
export function match(
    subject: Term | undefined,
    predicate: Term | undefined,
    object: Term | undefined,
): BasicLensM<Quad[], Cont<Quad>> {
    return new BasicLensM<Quad[], Cont<Quad>>((quads) => {
        return quads
            .filter(
                (x) =>
                    (!subject || x.subject.equals(subject)) &&
                    (!predicate || x.predicate.equals(predicate)) &&
                    (!object || x.object.equals(object)),
            )
            .map((id) => ({ id, quads }));
    }).named("match", {
        subject: subject && termToString(subject),
        predicate: predicate && termToString(predicate),
        object: object && termToString(object),
    });
}

/**
 * Lens returning the subject of a quad.
 */
export const subject = new BasicLens<Cont<Quad>, Cont>(({ id, quads }) => ({
    id: id.subject,
    quads,
})).named("subject");

/**
 * Lens returning the predicate of a quad.
 */
export const predicate = new BasicLens<Cont<Quad>, Cont>(({ id, quads }) => ({
    id: id.predicate,
    quads,
})).named("predicate");

/**
 * Lens returning the object of a quad.
 */
export const object = new BasicLens<Cont<Quad>, Cont>(({ id, quads }) => ({
    id: id.object,
    quads,
})).named("object");

/**
 * Identity lens returning the input container unchanged.
 */
export function empty<C>(): BasicLens<C, C> {
    return new BasicLens((x) => x);
}

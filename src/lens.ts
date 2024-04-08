import type { Quad, Term } from "@rdfjs/types";

export type Cont<Q = Term> = { id: Q; quads: Quad[] };
export type Res<T> = [Term, T];

let lensIndex = 0;

export class BasicLens<C, T> {
  _exec: (container: C, state: any, states: any[]) => T;
  index: number;
  constructor(execute: (container: C, state: any, states: any[]) => T) {
    this._exec = execute;
    this.index = lensIndex;
    lensIndex += 1;
  }

  asMulti(): T extends any[] ? BasicLensM<C, T[number]> : never {
    return <T extends any[] ? BasicLensM<C, T[number]> : never>(
      new BasicLensM((c, _, states) => {
        const out = this.execute(c, states);
        return <T extends any[] ? any[] : never>out;
      })
    );
  }

  and<F extends any[]>(
    ...and: { [K in keyof F]: BasicLens<C, F[K]> }
  ): BasicLens<C, [T, ...{ [K in keyof F]: F[K] }]> {
    return <BasicLens<C, [T, ...{ [K in keyof F]: F[K] }]>>(
      new BasicLens((c, _, states) => {
        const a = this.execute(c, states);
        const rest: F = <any>and.map((x) => x.execute(c, states));
        return [a, ...rest];
      })
    );
  }

  orM(...others: BasicLens<C, T>[]): BasicLensM<C, T> {
    return new BasicLensM((c, _, states) => {
      const all = [this, ...others];
      return all.flatMap((x) => {
        try {
          return [x.execute(c, states)];
        } catch (ex: any) {
          return [];
        }
      });
    });
  }

  or(...others: BasicLens<C, T>[]): BasicLens<C, T> {
    return new BasicLens((c, _, states) => {
      try {
        return this.execute(c, states);
      } catch (ex: any) {
        for (let i = 0; i < others.length; i++) {
          try {
            return others[i].execute(c, states);
          } catch (ex) {}
        }
      }
      throw "nope";
    });
  }

  map<F>(fn: (t: T) => F): BasicLens<C, F> {
    return new BasicLens((c, _, states) => {
      const a = this.execute(c, states);
      return fn(a);
    });
  }

  then<F>(next: BasicLens<T, F>): BasicLens<C, F> {
    return new BasicLens((c, _, states) => {
      const a = this.execute(c, states);
      return next.execute(a, states);
    });
  }

  execute(container: C, states: any[] = []): T {
    if (!states[this.index]) {
      states[this.index] = {};
    }
    return this._exec(container, states[this.index], states);
  }
}

export class BasicLensM<C, T> extends BasicLens<C, T[]> {
  one<D = T>(def?: D): BasicLens<C, T | D> {
    return new BasicLens((c, _, states) => {
      const qs = this.execute(c, states);
      return qs[0] || def!;
    });
  }
  expectOne(): BasicLens<C, T> {
    return new BasicLens((c, _, states) => {
      const qs = this.execute(c, states);
      if (qs.length < 1) throw "Nope";
      return qs[0];
    });
  }

  thenAll<F>(next: BasicLens<T, F>): BasicLensM<C, F> {
    return new BasicLensM((c, _, states) => {
      const qs = this.execute(c, states);
      return qs.flatMap((x) => {
        try {
          const o = next.execute(x, states);
          return [o];
        } catch (ex: any) {
          return [];
        }
      });
    });
  }
  thenSome<F>(next: BasicLens<T, F>): BasicLensM<C, F> {
    return this.thenAll(next);
  }

  thenFlat<F>(next: BasicLensM<T, F>): BasicLensM<C, F> {
    return new BasicLensM((c, _, states) => {
      const qs = this.execute(c, states);
      return qs.flatMap((x) => next.execute(x, states));
    });
  }
  mapAll<F>(fn: (t: T) => F): BasicLensM<C, F> {
    return new BasicLensM((c, _, states) => {
      const qs = this.execute(c, states);
      return qs.map(fn);
    });
  }

  orAll(...others: BasicLensM<C, T>[]): BasicLensM<C, T> {
    return new BasicLensM((c, _, states) => {
      let out = [];
      try {
        out.push(...this.execute(c, states));
      } catch (ex: any) {}
      for (let i = 0; i < others.length; i++) {
        try {
          out.push(...others[i].execute(c, states));
        } catch (ex: any) {}
      }

      return out;
    });
  }

  filter(fn: (object: T) => boolean): BasicLensM<C, T> {
    return new BasicLensM((c, _, states) => {
      return this.execute(c, states).filter(fn);
    });
  }
}

export function pred(pred?: Term): BasicLensM<Cont, Cont> {
  return new BasicLensM(({ quads, id }) => {
    const out = quads.filter(
      (q) => q.subject.equals(id) && (!pred || q.predicate.equals(pred)),
    );
    return out.map((q) => ({ quads, id: q.object }));
  });
}

export function invPred(pred?: Term): BasicLensM<Cont, Cont> {
  return new BasicLensM(({ quads, id }) => {
    const out = quads.filter(
      (q) => q.object.equals(id) && (!pred || q.predicate.equals(pred)),
    );
    return out.map((q) => ({ quads, id: q.subject }));
  });
}

export function predTriple(pred?: Term): BasicLensM<Cont, Cont<Quad>> {
  return new BasicLensM(({ quads, id }) => {
    const out = quads.filter(
      (q) => q.subject.equals(id) && (!pred || q.predicate.equals(pred)),
    );
    return out.map((q) => ({ quads, id: q }));
  });
}

export function unique(): BasicLensM<Cont[], Cont> {
  return new BasicLensM((qs) => {
    const literals: { [id: string]: Cont } = {};
    const named: { [id: string]: Cont } = {};
    const blank: { [id: string]: Cont } = {};
    for (let q of qs) {
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
  });
}

export function subjects(): BasicLensM<Quad[], Cont> {
  return new BasicLensM((quads) => {
    return quads.map((x) => ({ id: x.subject, quads }));
  });
}

export function match(
  subject: Term | undefined,
  predicate: Term | undefined,
  object: Term | undefined,
): BasicLensM<Quad[], Cont<Quad>> {
  return new BasicLensM((quads) => {
    return quads
      .filter(
        (x) =>
          (!subject || x.subject.equals(subject)) &&
          (!predicate || x.predicate.equals(predicate)) &&
          (!object || x.object.equals(object)),
      )
      .map((id) => ({ id, quads }));
  });
}

export const subject: BasicLens<Cont<Quad>, Cont> = new BasicLens(
  ({ id, quads }) => ({
    id: id.subject,
    quads,
  }),
);

export const predicate: BasicLens<Cont<Quad>, Cont> = new BasicLens(
  ({ id, quads }) => ({
    id: id.predicate,
    quads,
  }),
);

export const object: BasicLens<Cont<Quad>, Cont> = new BasicLens(
  ({ id, quads }) => ({
    id: id.object,
    quads,
  }),
);

export function empty<C>(): BasicLens<C, C> {
  return new BasicLens((x) => x);
}

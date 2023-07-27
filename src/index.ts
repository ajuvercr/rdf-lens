import { Quad, Store, Term } from "@rdfjs/types";

export type Cont = { id: Term, quads: Quad[] };
export type Res<T> = [Term, T];

export interface Lens<C, T> {
  map<F>(fn: (t: T) => F): Lens<C, F>;
  then<F>(next: Lens<T, F>): Lens<C, F>;
  and<F>(and: Lens<C, F>): Lens<C, [T, F]>;
  execute(container: C): T;
}

export class BasicLens<C, T> implements Lens<C, T> {
  _exec: (container: C) => T;
  constructor(execute: (container: C) => T) {
    this._exec = execute;
  }

  and<F extends any[]>(...and: { [K in keyof F]: Lens<C, F[K]>; }): BasicLens<C, [T, ...{ [K in keyof F]: F[K]; }]> {
    return <BasicLens<C, [T, ...{ [K in keyof F]: F[K]; }]>> new BasicLens((c) => {
      const a = this.execute(c);
      const rest: F = <any> and.map(x => x.execute(c));
      return [a, ...rest];
    });
  }

  map<F>(fn: (t: T) => F): BasicLens<C, F> {
    return new BasicLens((c) => {
      const a = this.execute(c);
      return fn(a);
    });
  }

  then<F>(next: Lens<T, F>): BasicLens<C, F> {
    return new BasicLens((c) => {
      const a = this.execute(c);
      return next.execute(a);
    });
  }

  execute(container: C): T {
    return this._exec(container);
  }
}

export function pred(pred: Term): BasicLens<Cont, Cont> {
  return new BasicLens(({ quads, id }) => {
    const out = quads
      .find(q => q.subject.equals(id) && q.predicate.equals(pred));

    if (out) {
      return { quads, id: out.object };
    }

    throw "nope";
  });
}

export function subjects(): Lens<Quad[], Cont[]> {
  return new BasicLens(quads => {
    return quads.map(x => ({ id: x.subject, quads }));
  });
}



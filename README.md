# RDF-Lens

Look into a dataset with RDF-Lens.
Here the term Lens, is the same concept of Haskell lenses available in [this well known library](https://hackage.haskell.org/package/lens).

A lens looks at a point in a dataset, for RDF-Lens this usually is looking at a Term inside a store.
Lenses can be combined to from a point, look furthur inside the dataset, as long as the types allow for it.

Currently two lenses exist in RDF-Lens `BasicLens<C, T>` and `BasicLensM<C, T>` (M stands for Multiple: `BasicLensM<C, T>` is a subclass of `BasicLens<C, T[]>`). 
C stands for Container, a combination of the store and the current target. T stands for resulting type.

`BasicLens<C, T>` can be combined with `BasicLens<T, D>` and will result in `BasicLens<C, D>`.


## Examples

### Pred

A very common Lens is created with `pred` and takes in a predicate term and returns `BasicLensM<Cont, Cont>`.
So it starts pointing inside the dataset and results in pointing to multiple things inside the dataset.
Using the function `.thenFlat` another predicate can be chained to explore the dataset deper.


### Extracting data

RDF-Lens tries to make it developer friendly and typed to extract data from a RDF store.
This example shows how to extract a point with two coordinates from the data.
```typescript 
import { pred } from "rdf-lens";
import { DataFactory, Parser } from "n3";

const { namedNode } = DataFactory;

const extractX = pred(namedNode("x"))         // Follow predicate <x>
  .one()                                      // We expect only to find one term
  .map(({id}) => ({x: id.value}));            // Map that term to a Json Object
  
const extractY = pred(namedNode("y"))         // Follow predicate <y>
  .one()                                      // We expect only to find one term
  .map(({id}) => ({y: id.value}));            // Map that term to a Json Object
  
const pointLens = extractX.and(extractY)      // Combine both lenses
  .map(([{x}, {y}]) => ({x, y}));             // Map them together to a point object

const turtle = "<a> <x> 42; <y> 43.";
const quads = new Parser().parse(turtle);     // Parser quads 
const point = pointLens.execute({id: namedNode("a"), quads});  // Execute the lens over the dataset
```


### Extracting RDF list items

Extracting point data is not very exciting, this example shows how to extract all items from a RDF List.

```typescript
const RDFListElement = pred(RDF.first).one().and(pred(RDF.rest).one());

// RdfList is a Lens that takes in a Container pointing to a Term and returns a list of Terms 
const RdfList: BasicLens<Cont, Term[]> = new BasicLens((c) => {
  if (c.id.equals(RDF.nil)) {
    return [];
  }

  const [first, rest] = RDFListElement.execute(c);
  const els = RdfList.execute(rest);
  els.unshift(first.id);
  return els;
});
```

### Extracting starting from shacl shapes

Shacl shapes are used widely to constrain rdf data to some shape.
With rdf-lens you can extract data starting from a shape to a plain old javascript object.
The field names are defined by the `sh:name`, that is part of the `sh:property` object.

This examples shows how to define and extract a point.
```turtle
# The shacl shape for a point
[] a sh:NodeShape;
  sh:targetClass <Point>; # Derive a lens for js:Point
  sh:property [
    sh:name "x";             # Field x
    sh:path <x>;            # is found at path `js:x`
    sh:datatype xsd:integer; # and is an integer
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:datatype xsd:integer;
    sh:path <y>;
    sh:name "y";
    sh:maxCount 1;
    sh:minCount 1;
  ].
```

```turtle
# Data that adheres to that shape
<MyPoint> a <Point>;
  <x> 5;
  <y> 8.
```

Let's use this data to extract a point.
```typescript
const shapes = extractShapes(shapeQuads);
const quads = parseQuads(dataQuads);

const lens = shapes.lenses["Point"]; // The lens that extracts a point
const point = lens.execute({id: namedNode("MyPoint"), quads});

console.log(point); // { "x": 5, "y": 8 }
```


**Deep objects** are also supported, let's reuse the point shape to extract a line.

```turtle
[] a sh:NodeShape;
  sh:targetClass <Line>;
  sh:property [
    sh:name "start";  // The start is a point
    sh:path <start>;
    sh:class <Point>;
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:name "end";    // The end is a point
    sh:path <end>;
    sh:class <Point>;
    sh:maxCount 1;
    sh:minCount 1;
  ].
```

Note: `sh:datatype` is used for literals, `sh:class` is used for objects, and `sh:nodeKind` is used to take a term as it is.

* `sh:minCount` tells rdf-lens that this property is required, and will fail to parse an object that does not adhere to the shape.
* `sh:maxCount` tells rdf-lens whether or not to expect multiple objects. If this is not set or is bigger than 1, the Javascript object will have an array as its value.
* `sh:defaultValue` tells rdf-lens what to use when the data has no value for this property. A default satisfies `sh:minCount`, so a required property with a default never fails to parse.

**Default values** are extracted the same way the data would have been, but from the shapes graph:

```turtle
[] a sh:NodeShape;
  sh:targetClass <Me>;
  sh:property [
    sh:name "name";
    sh:path <name>;
    sh:datatype xsd:string;
    sh:defaultValue "ajuvercr";   # A literal is converted with sh:datatype
    sh:maxCount 1;
    sh:minCount 1;
  ], [
    sh:name "age";
    sh:path <age>;
    sh:datatype xsd:integer;
    sh:maxCount 1;
    sh:minCount 1;
  ].
```

```turtle
<foobar> a <Me>;
  <age> 95.
```

extracts to `{ "name": "ajuvercr", "age": 95 }`.

For a `sh:class` property the default is a node, and it is extracted through that class's shape. Its own properties are read from the shapes graph, and whatever it leaves out falls back to the defaults of that shape in turn:

```turtle
[] a sh:NodeShape;
  sh:targetClass <Friend>;
  sh:property [
    sh:name "friend";
    sh:path <friend>;
    sh:class <Me>;
    sh:defaultValue [ <age> 95 ];   # <name> comes from the Me shape default
    sh:maxCount 1;
    sh:minCount 1;
  ].
```

`<foobar> a <Friend>.` extracts to `{ "friend": { "name": "ajuvercr", "age": 95 } }`. The same happens one level down: a friend that is present in the data but has no `<name>` still gets `"ajuvercr"`.

For a property that holds multiple values, the default may be a single value or an RDF list, and it is only used when the data has no values at all.

**Extracting terms** with `sh:nodeKind` and `rdfl:codeType`. Sometimes the term itself is what you want, not a converted literal or a nested object. `sh:nodeKind` says which kind of term a property holds, `rdfl:codeType` what to turn it into. A property written as an IRI, so the parser resolves it against the base, can still be read as a string:

```turtle
[] a sh:NodeShape;
  sh:targetClass <Document>;
  sh:property [
    sh:name "source";
    sh:path <source>;
    sh:nodeKind sh:IRI;        # written as <./data.ttl>, resolved by the parser
    rdfl:codeType xsd:string;  # read as "file:///.../data.ttl", leave out for a NamedNode
    sh:maxCount 1;
  ].
```

* All six node kinds are supported: `sh:IRI`, `sh:BlankNode`, `sh:Literal`, `sh:BlankNodeOrIRI`, `sh:BlankNodeOrLiteral` and `sh:IRIOrLiteral`. A value of another kind fails to parse, like a cardinality violation.
* Either can be used alone: `sh:nodeKind` hands you the term, `rdfl:codeType` converts any term.
* `rdfl:codeType` takes a datatype, like `sh:datatype`. `xsd:anyURI` gives an IRI, from an IRI or from a string holding an absolute IRI, so `sh:nodeKind sh:IRIOrLiteral; rdfl:codeType xsd:anyURI` accepts `<https://example.org>` and `"https://example.org"` alike. Node kinds and `xsd:iri` are not code types.
* `rdfl:codeType rdfl:Term` converts nothing: it hands back the term the parser produced, instead of rebuilding it with this library's data factory.
* An `rdfl:EnvVariable` holds a string, so it becomes an IRI when the kind allows one and the value is an absolute IRI, a literal when the kind allows that, and an error otherwise.

**Which one applies.** The first of these a property has decides how it is extracted:

1. `sh:class`: a nested object, built with the shape of that class.
2. `sh:nodeKind` or `rdfl:codeType`: the term, checked against the kind and converted with `rdfl:codeType`, or with `sh:datatype` when there is no `rdfl:codeType` (rdf-lens warns when both are given and differ).
3. `sh:datatype`: the value converted with that datatype.

> [!WARNING]
> `sh:datatype` describes literals, but rdf-lens used it on any term, so `sh:datatype xsd:string` turns IRIs and blank nodes into strings and `sh:datatype xsd:iri` (not an actual datatype) asks for the IRI itself. Both still work, but log a warning naming the property, its path and its shape: `xsd:iri` when the shape is read, a converting datatype the first time it is given an IRI or blank node. The replacements extract the same values: `sh:nodeKind sh:IRI` for `sh:datatype xsd:iri`, and `sh:nodeKind sh:IRI; rdfl:codeType xsd:string` for `sh:datatype xsd:string` holding IRIs.

**Special implemented classes**
Sometimes a plain old javascript objects is not enough, some special classes work out of the box.
`@prefix rdfs: <https://w3id.org/rdf-lens/ontology#>.`

* `rdfl:CBD`: Provides a list of quads bounded by the cbd algorithm.
* `rdfl:PathLens`: Parses a shacl Path and returns a Lens that resolves this path.
* `rdfl:Context`: Provides a reference to the list of all data quads.
* `rdfl:TypeExtract`: Extracts according to the `rdf:type` object (including class hierarchy), by using the shape that corresponds to that type.

## Indexed stores

Lenses walk quads by pattern: `pred()` looks for a subject and a predicate, `invPred()` for an object and a predicate, `match()` for any combination. Over a `Quad[]` every such step scans the whole array, so a lens that follows three hops over a large dataset scans it three times.

Instead of an array, the `quads` field of a container may hold anything with a `getQuads` method, and every lens will query it instead of scanning:

```typescript
export interface QuadStore {
    getQuads(
        subject: Term | null,
        predicate: Term | null,
        object: Term | null,
        graph: Term | null,
    ): Quad[];
}
```

This is the `getQuads` signature of [N3.Store](https://github.com/rdfjs/N3.js#storing), so an N3 store can be passed straight in:

```typescript
import { Store } from "n3";
import { match, subject, unique, createContext } from "rdf-lens";

const store = new Store(quads);

const people = match(undefined, rdfType, personType)
    .thenAll(subject)
    .then(unique())
    .execute(store, createContext());
```

The same holds for a container built by hand, and for shape extraction:

```typescript
const person = shapes.lenses["http://example.org/Person"].execute(
    { id: alice, quads: store },
    createContext(),
);
```

Arrays keep working exactly as before, and both inputs return the same terms - `test/store.test.ts` asserts that per lens. What changes is the cost. On ~50K quads, `test/performance.test.ts` measures roughly:

| Query | `Quad[]` | store |
| --- | --- | --- |
| single `match` on `rdf:type` | 2.4ms | 0.4ms |
| three hop `pred` chain | 20ms | 0.3ms |
| `match` plus a `pred` filter per result | 127ms | 1.5ms |

The gap widens with the dataset: a single lookup is a scan of every quad versus an index hit, so the more quads there are, the more a store pays off. Below a few thousand quads an array is fine, and building the index is itself work.

## API reference

### Building blocks

| | |
| --- | --- |
| `pred(predicate?)` | Follow outgoing edges, optionally filtered by predicate |
| `invPred(predicate?)` | Follow incoming edges, optionally filtered by predicate |
| `predTriple(predicate?)` | Like `pred`, but keeps the whole quad |
| `match(subject, predicate, object)` | All quads matching a pattern, `undefined` is a wildcard |
| `subjects()` | The subject of every quad |
| `subject`, `predicate`, `object` | The corresponding term of a `Cont<Quad>` |
| `unique()` | Deduplicate containers on term type and value |
| `empty<C>()` | Identity lens, useful as a starting point |
| `createContext()` | A fresh execution context, carries lineage for error messages |
| `matchQuads(quads, s?, p?, o?)` | Pattern lookup used by the lenses above, on an array or a store |

`pred`, `invPred`, `predTriple`, `match` and `subjects` return a `BasicLensM`, a lens that yields many results.

### BasicLens&lt;C, T&gt;

| | |
| --- | --- |
| `then(next)` | Feed the result into `next` |
| `map(fn)` | Transform the result |
| `and(...others)` | Run several lenses on the same input, results as a tuple |
| `or(...others)` | First lens that does not throw; throws the collected errors if none succeed |
| `orM(...others)` | Results of all lenses that did not throw, as a `BasicLensM` |
| `safe(def)` | The result, or `def` if the lens throws |
| `asMulti()` | Reinterpret a lens returning `T[]` as a `BasicLensM` |
| `named(name, opts?)` | Label this step, so failures point at it |
| `execute(input, ctx?)` | Run the lens |

### BasicLensM&lt;C, T&gt;

Extends `BasicLens<C, T[]>`, so everything above is available too.

| | |
| --- | --- |
| `one(def?)` | First result, or `def`; throws when empty and no default was given |
| `expectOne()` | First result, throws when empty |
| `thenAll(next)` | Apply `next` to every result, fails if any of them fails |
| `thenSome(next)` | Apply `next` to every result, drop the ones that fail |
| `thenFlat(next)` | Apply a multi valued `next` to every result and flatten |
| `mapAll(fn)` | Transform every result |
| `filter(fn)` | Keep the results matching `fn` |
| `orAll(...others)` | All results of all lenses, ignoring the ones that throw |
| `reduce(lens, start)` | Fold the results with an accumulator lens |

### Chaining

A lens is `BasicLens<C, T>`: it takes a `C` and produces a `T`. Two lenses chain with `then` when the first produces what the second consumes.

```typescript
// Cont -> Cont[] -> Cont -> string
pred(foaf.knows)      // BasicLensM<Cont, Cont>
    .one()            // BasicLens<Cont, Cont>
    .map(({ id }) => id.value);
```

Most lenses pass containers around, so they compose freely: `pred()`, `invPred()` and `unique()` all take a `Cont` and produce a `Cont`. `match()` and `predTriple()` produce a `Cont<Quad>` instead, which `subject`, `predicate` and `object` turn back into a `Cont`:

```typescript
// Quads -> Cont<Quad>[] -> Cont[] -> Cont[]
match(undefined, rdfType, personType)
    .thenAll(subject)
    .then(unique());
```

`match()` and `subjects()` take the quads themselves rather than a container, so they start a chain rather than continue one.

Multi valued lenses chain per element: `thenAll` and `thenSome` apply a single valued lens to each result, `thenFlat` applies a multi valued one and flattens. `one()` and `expectOne()` go back to a single value.

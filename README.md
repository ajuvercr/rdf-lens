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

Note: `sh:datatype` is used for literals, `sh:class` is used for objects.

* `sh:minCount` tells rdf-lens that this property is required, and will fail to parse an object that does not adhere to the shape.
* `sh:maxCount` tells rdf-lens whether or not to expect multiple objects. If this is not set or is bigger than 1, the Javascript object will have an array as its value.



**Special implemented classes**
Sometimes a plain old javascript objects is not enough, some special classes work out of the box.
`@prefix rdfs: <https://w3id.org/rdf-lens/ontology#>.`

* `rdfl:CBD`: Provides a list of quads bounded by the cbd algorithm.
* `rdfl:PathLens`: Parses a shacl Path and returns a Lens that resolves this path.
* `rdfl:Context`: Provides a reference to the list of all data quads.
* `rdfl:TypeExtract`: Extracts according to the `rdf:type` object (including class hierarchy), by using the shape that corresponds to that type.

## Indexed Store Performance

RDF-Lens supports indexed stores for O(1) query performance on large datasets. The `quads` field in containers can be either a `Quad[]` array or a `QuadStore` for indexed lookups. Lens operations like `match()`, `pred()`, and `invPred()` automatically detect and use indexed stores when available.

### QuadStore Interface

```typescript
export interface QuadStore {
    getQuads(
        subject: Term | undefined,
        predicate: Term | undefined,
        object: Term | undefined,
        graph?: Term | undefined
    ): Quad[];
}
```

This matches the W3C RDF/JS DatasetCore interface, making it compatible with:
- LVX Store (binary RDF format with pre-built indexes)
- N3 Store (in-memory RDF store)
- Any W3C RDF/JS compliant store

### Usage with LVX Store

```typescript
import { LVXStore } from 'mdld-lvx';
import { match, subjects, createContext } from 'rdf-lens';

const quads = mdldParse(dataMD).quads;
const store = new LVXStore(quads, { buildIndexes: true });

// Pass store directly to subjects() or match()
const result = match(undefined, rdfType, userType)
    .execute(store, createContext());
```

### Usage with N3 Store

```typescript
import { Store } from 'n3';
import { match, subjects, createContext } from 'rdf-lens';

const store = new Store();
store.addQuads(quads);

// Pass store directly to subjects() or match()
const result = match(undefined, rdfType, userType)
    .execute(store, createContext());
```

### Performance Benefits

- **Linear scanning (Quad[]):** O(n) where n is number of quads
- **Indexed store (QuadStore):** O(1) for pattern matching
- **Typical improvement:** 30-400x faster for large datasets (>10K quads)

The `quads` field accepts both `Quad[]` and `QuadStore`, so existing code with arrays works unchanged. Pass a store when you need the performance boost.

## Chainable Functions Reference

### Top-Level Functions

**Traversal Functions:**
- `match(subject, predicate, object)` - Matches quads by pattern (subject, predicate, object)
- `pred(pred?)` - Traverse outgoing edges with optional predicate filter
- `invPred(pred?)` - Traverse incoming edges with optional predicate filter
- `predTriple(pred?)` - Return triple containers matching a subject/predicate
- `subjects()` - Extract all subjects from quads into containers

**Quad Accessors:**
- `subject` - Lens returning the subject of a quad
- `predicate` - Lens returning the predicate of a quad
- `object` - Lens returning the object of a quad

**Utility Functions:**
- `unique()` - Deduplicate containers by term type and value
- `empty()` - Identity lens returning input unchanged
- `createContext()` - Create a fresh context for lens execution

### BasicLens Methods (Single-Value Lenses)

**Composition:**
- `and(...and)` - Combine lenses, return tuple of results
- `then(next)` - Chain this lens with another lens
- `or(...others)` - Return first successful result from fallback lenses
- `orM(...others)` - Aggregate results from multiple lenses ignoring failures

**Transformation:**
- `map(fn)` - Transform result with mapping function
- `asMulti()` - Convert to multi-valued lens

**Execution:**
- `execute(container, ctx?)` - Execute lens with optional context
- `named(name, opts?, cb?)` - Add lineage tracking for debugging

### BasicLensM Methods (Multi-Value Lenses)

**Element Access:**
- `one(def?)` - Return first element or default value
- `expectOne()` - Return first element or throw if empty

**Composition:**
- `thenAll(next)` - Apply lens to each element
- `thenSome(next)` - Apply lens to each element, ignore failures
- `thenFlat(next)` - Apply multi-valued lens to each element and flatten
- `orAll(...others)` - Combine results from multiple multi-lenses

**Transformation:**
- `mapAll(fn)` - Map function over all elements
- `filter(fn)` - Filter result array by predicate
- `reduce(lens, start)` - Reduce using accumulator lens

**Execution:**
- `named(name, opts?, cb?)` - Add lineage tracking for debugging

## Chaining Rules and Type Compatibility

### Core Principle
Lenses can be chained based on **type compatibility** between the output type of one lens and the input type of the next. The chaining rules depend on whether you're working with single-valued (`BasicLens`) or multi-valued (`BasicLensM`) lenses.

### Type Hierarchy
```
BasicLens<C, T>  (single-valued lens)
    ↓ asMulti()
BasicLensM<C, T>  (multi-valued lens, extends BasicLens<C, T[]>)
```

### Single-Valued Lens Chaining (BasicLens)

**Output type:** `T` (single value)
**Can chain to:** Any lens that accepts `T` as input

**Valid sequences:**
```typescript
// BasicLens<C, T> → BasicLens<T, F>
pred(predicate).then(anotherLens)

// BasicLens<C, T> → BasicLens<C, F> (transformation)
pred(predicate).map(fn)

// BasicLens<C, T> → BasicLens<C, [T, F]> (combination)
pred(p1).and(pred(p2))

// BasicLens<C, T> → BasicLensM<C, T> (convert to multi)
pred(predicate).asMulti()

// BasicLens<C, T> → BasicLens<C, T> (fallback)
pred(p1).or(pred(p2))

// BasicLens<C, T> → BasicLensM<C, T> (aggregate, ignore failures)
pred(p1).orM(pred(p2))
```

### Multi-Valued Lens Chaining (BasicLensM)

**Output type:** `T[]` (array of values)
**Can chain to:** Lenses that handle arrays or apply to each element

**Valid sequences:**
```typescript
// BasicLensM<C, T> → BasicLensM<C, F> (apply to each element)
pred(predicate).thenAll(extractLens)

// BasicLensM<C, T> → BasicLensM<C, F> (apply to each, ignore failures)
pred(predicate).thenSome(extractLens)

// BasicLensM<C, T> → BasicLensM<C, F> (apply multi-valued lens, flatten)
pred(predicate).thenFlat(anotherMultiLens)

// BasicLensM<C, T> → BasicLensM<C, T> (filter elements)
pred(predicate).filter(fn)

// BasicLensM<C, T> → BasicLensM<C, F> (map over elements)
pred(predicate).mapAll(fn)

// BasicLensM<C, T> → BasicLensM<C, T> (combine multi-lenses)
pred(p1).orAll(pred(p2))

// BasicLensM<C, T> → BasicLens<C, T> (convert to single, get first)
pred(predicate).one(defaultValue)

// BasicLensM<C, T> → BasicLens<C, T> (convert to single, throw if empty)
pred(predicate).expectOne()
```

### Container Type Compatibility

**Cont<Q> = { id: Q; quads: Quad[] | QuadStore }**

Functions that return `Cont` can chain to functions that accept `Cont`:
- `pred()` → returns `Cont` → can chain to `pred()`, `invPred()`, `subject`, etc.
- `invPred()` → returns `Cont` → can chain to `pred()`, `invPred()`, `subject`, etc.
- `subject` → returns `Cont` → can chain to `pred()`, `invPred()`, etc.

Functions that return `Cont<Quad>` can chain to quad accessors:
- `match()` → returns `Cont<Quad>` → can chain to `subject`, `predicate`, `object`
- `predTriple()` → returns `Cont<Quad>` → can chain to `subject`, `predicate`, `object`

### Special Input Types

**Array inputs (Quad[], Cont[]):**
- `unique()` - accepts `Cont[]` → returns `Cont`
- `subjects()` - accepts `Quad[]` → returns `Cont`
- `match()` - accepts `Quad[]` → returns `Cont<Quad>`

These must come **first** in a chain or be used with appropriate input:
```typescript
// Valid: start with array input
subjects().execute(quads, ctx)

// Valid: chain after conversion
match().then(subject).execute(quads, ctx)

// Invalid: unique() needs array input
pred().unique()  // ERROR: unique() expects Cont[], not Cont
```

### Common Chaining Patterns

**Pattern 1: Navigate and extract**
```typescript
pred(predicate)          // BasicLensM<Cont, Cont>
  .one()                 // BasicLens<Cont, Cont>
  .map(({ id }) => ...)  // BasicLens<Cont, Object>
```

**Pattern 2: Filter and transform**
```typescript
match(s, p, o)           // BasicLensM<Quad[], Cont<Quad>>
  .then(subject)         // BasicLensM<Quad[], Cont>
  .mapAll(fn)            // BasicLensM<Quad[], F>
  .filter(predicate)     // BasicLensM<Quad[], F>
```

**Pattern 3: Combine results**
```typescript
pred(p1)                // BasicLensM<Cont, Cont>
  .and(pred(p2))         // BasicLens<Cont, [Cont, Cont]>
  .map(([a, b]) => ...)  // BasicLens<Cont, Object>
```

**Pattern 4: Multi-step navigation**
```typescript
pred(p1)                // BasicLensM<Cont, Cont>
  .thenFlat(pred(p2))    // BasicLensM<Cont, Cont>
  .thenFlat(pred(p3))    // BasicLensM<Cont, Cont>
  .mapAll(fn)            // BasicLensM<Cont, F>
```

**Pattern 5: Deduplicate after navigation**
```typescript
pred(p1)                // BasicLensM<Cont, Cont>
  .thenFlat(pred(p2))    // BasicLensM<Cont, Cont>
  .asMulti()             // BasicLensM<Cont, Cont>
  .then(unique())        // BasicLensM<Cont, Cont>
```

### SHACL-Specific Chaining

**Path lenses return lenses:**
- `ShaclPath` - returns `BasicLensM<Cont, Cont>` (can be used directly)
- `ShaclSequencePath` - returns `BasicLens<Cont, BasicLensM<Cont, Cont>>` (execute to get lens)
- `ShaclAlternativepath` - returns `BasicLens<Cont, BasicLensM<Cont, Cont>>` (execute to get lens)

**Usage pattern:**
```typescript
pred(SHACL.path)        // BasicLensM<Cont, Cont>
  .one()                 // BasicLens<Cont, Cont>
  .then(ShaclPath)       // BasicLens<Cont, BasicLensM<Cont, Cont>>
  .thenFlat(...)         // Use the returned lens
```

### Invalid Chaining Examples

```typescript
// ERROR: unique() needs Cont[] input
pred().unique()

// ERROR: subjects() needs Quad[] input
pred().subjects()

// ERROR: subject needs Cont<Quad> input
pred().subject

// ERROR: then() needs BasicLens<T, F>, not function
pred().then(fn)

// ERROR: thenAll() needs BasicLens<T, F>, not BasicLensM
pred().thenAll(anotherMultiLens)  // Use thenFlat instead
```

### Quick Reference

| Current Type | Can Chain To | Method |
|--------------|--------------|--------|
| `BasicLens<C, T>` | `BasicLens<T, F>` | `then()` |
| `BasicLens<C, T>` | `BasicLens<C, F>` | `map()` |
| `BasicLens<C, T>` | `BasicLens<C, [T, ...]>` | `and()` |
| `BasicLens<C, T>` | `BasicLensM<C, T>` | `asMulti()`, `orM()` |
| `BasicLensM<C, T>` | `BasicLensM<C, F>` | `thenAll()`, `thenSome()`, `thenFlat()` |
| `BasicLensM<C, T>` | `BasicLens<C, T>` | `one()`, `expectOne()` |
| `BasicLensM<C, T>` | `BasicLensM<C, T>` | `mapAll()`, `filter()`, `orAll()` |
| `Cont<Quad>` | `Cont` | `subject`, `predicate`, `object` |
| `Cont` | `Cont` | `pred()`, `invPred()` |
| `Quad[]` | `Cont` | `subjects()`, `match()` |
| `Cont[]` | `Cont` | `unique()` |


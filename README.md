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

**Extracting terms** with `sh:nodeKind`. Not every value is a literal to convert or a nested object to build: sometimes the term itself is what you want, an IRI you are going to dereference or pass along. `sh:nodeKind` says which kind of term a property holds, and rdf-lens hands you that term.

```turtle
[] a sh:NodeShape;
  sh:targetClass <Document>;
  sh:property [
    sh:name "source";
    sh:path <source>;
    sh:nodeKind sh:IRI;   # `source` is a NamedNode, not a string
    sh:maxCount 1;
  ].
```

All six SHACL node kinds are supported: `sh:IRI`, `sh:BlankNode`, `sh:Literal`, `sh:BlankNodeOrIRI`, `sh:BlankNodeOrLiteral` and `sh:IRIOrLiteral`. A value whose term type the node kind does not allow fails to parse, the same way a cardinality violation does. If a property has both `sh:nodeKind` and `sh:datatype`, the datatype wins and the value is converted.

**Terms as plain values** with `rdfl:datatype`. A property is often written as an IRI so the Turtle parser resolves it against the base, while the code reading it just wants a string. Those are two questions: `sh:nodeKind` says what is in the configuration, `rdfl:datatype` says what to turn it into.

```turtle
[] a sh:NodeShape;
  sh:targetClass <Document>;
  sh:property [
    sh:name "source";
    sh:path <source>;
    sh:nodeKind sh:IRI;        # written as <./data.ttl>, resolved by the parser
    rdfl:datatype xsd:string;  # read as "file:///.../data.ttl"
    sh:maxCount 1;
  ].
```

Either can be used on its own: `sh:nodeKind` alone hands you the term, `rdfl:datatype` alone converts whatever term is there without constraining it.

`rdfl:datatype rdfl:Term` is the one value that converts nothing: it hands back the term object the parser produced, rather than rebuilding it with this library's data factory. Use it when identity matters, for instance when the extracted term is compared against terms from the same store.

> [!WARNING]
> `sh:datatype xsd:iri` is deprecated. There is no such datatype: `xsd:iri` was only ever rdf-lens's way of asking for the IRI itself, which is what `sh:nodeKind sh:IRI` means in SHACL. Shapes using it keep working and now log a deprecation warning naming the property, its path and its shape. The two extract the same `NamedNode`, so the change is a drop in replacement.
>
> The other half of the same problem is quieter: a property declaring `sh:datatype xsd:string` converts *any* term by value, so it accepts IRIs and returns them as strings. Nothing in the shape says so, and a SHACL validator would reject the data against it. rdf-lens now reports those properties when it meets one, once per property, and the replacement is `sh:nodeKind sh:IRI` with `rdfl:datatype xsd:string` — again extracting the same value.



**Special implemented classes**
Sometimes a plain old javascript objects is not enough, some special classes work out of the box.
`@prefix rdfs: <https://w3id.org/rdf-lens/ontology#>.`

* `rdfl:CBD`: Provides a list of quads bounded by the cbd algorithm.
* `rdfl:PathLens`: Parses a shacl Path and returns a Lens that resolves this path.
* `rdfl:Context`: Provides a reference to the list of all data quads.
* `rdfl:TypeExtract`: Extracts according to the `rdf:type` object (including class hierarchy), by using the shape that corresponds to that type.


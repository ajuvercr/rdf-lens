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


Take a look at the tests to see how to extract Shacl shapes using RDF Lenses.



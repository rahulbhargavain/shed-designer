# Site Shed Designer

Structural design toolkit for a twin-module, skid-mounted portable site
shed (steel-tube frame, laminated cladding) sized for on-site cement
storage during construction.

**Live:** https://rahulbhargavain.github.io/shed-designer/

## Contents

- [`index.html`](index.html) — interactive site planner
- [`column-framework.html`](column-framework.html) — column formwork planner
- [`rcc-estimator.html`](rcc-estimator.html) — RCC estimator: concrete grade, TMT rebar, thickness, sub-base & subgrade for internal roads (IRC 58 / SP:62), drains and tank slabs (IS 456 / IS 3370) and warehouse floors (TR34), with cost-optimised BOQ. Engine: [`rcc-engine.js`](rcc-engine.js)
- [`site_shed_calculator.py`](site_shed_calculator.py) — CLI: bill of materials, cladding, fasteners, wind/buckling checks
- [`fabricator-guide-english.html`](fabricator-guide-english.html) / [`fabricator-guide-hindi.html`](fabricator-guide-hindi.html) — fabrication guides (+ PDF versions)
- [`site_shed_bom_and_analysis.md`](site_shed_bom_and_analysis.md) — full engineering write-up

## Usage

```bash
python site_shed_calculator.py [length] [width] [height] [rise] [bags] [tube_size] [tube_gauge]
# e.g. defaults: 9.8 11.0 8.0 2.5 250 2.0 16
```

## Tests

```bash
python -m pytest   # shed calculator
node --test        # RCC estimator engine (Node 18+)
```

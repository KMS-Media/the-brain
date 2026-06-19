# Claude Code Memory Plugin

## Product Requirements Document (PRD)

Version: 1.0
Status: MVP Definition
Author: Product Owner
Target: Claude Code Plugin

---

# 1. Vision

Claude Code besitzt standardmäßig kein langfristiges Projektgedächtnis.

Ziel dieses Projekts ist die Entwicklung eines lokalen, persistenten Memory-Systems, das Claude Code ermöglicht:

* Projektwissen dauerhaft zu speichern
* Architekturentscheidungen zu behalten
* Review-Erkenntnisse dauerhaft anzuwenden
* Erfahrungen wiederzuverwenden
* Beziehungen zwischen Wissen zu verstehen
* Kontext automatisch vor jedem Prompt bereitzustellen

Das System soll sich wie ein langfristiges Gedächtnis für Claude Code verhalten.

---

# 2. Ziele

## Hauptziele

### G1 – Projektgedächtnis

Claude soll Projektwissen dauerhaft behalten.

### G2 – Entscheidungswissen

Getroffene Architekturentscheidungen dürfen nicht verloren gehen.

### G3 – Review-Lernen

Bereits gefundene Code-Review-Probleme dürfen möglichst nicht erneut auftreten.

### G4 – Wissensvernetzung

Zusammenhänge zwischen Komponenten sollen verstanden werden.

### G5 – Token-Einsparung

Nur relevanter Kontext wird in den Prompt eingefügt.

### G6 – Vollständige Lokalisierung

Alle Daten verbleiben lokal auf dem Rechner des Benutzers.

---

# 3. Nicht-Ziele

Nicht Bestandteil des MVP:

* Cloud-Synchronisation
* Team-Sharing
* SaaS-Betrieb
* Externe Datenbanken
* Externe Embedding APIs

---

# 4. Zielarchitektur

```text
Claude Code
      ↓
Memory Plugin
      ↓
GraphQL API
      ↓
Retrieval Engine
      ↓
Kuzu Graph Database
      ↓
Embedding Store
      ↓
Local Filesystem
```

---

# 5. Technologie-Stack

## Datenbank

Kuzu Graph Database

Begründung:

* Embedded
* Lokal
* Hohe Performance
* Graph Traversal
* Cypher-ähnliche Queries
* Perfekt für Wissensgraphen

---

## API

GraphQL

Claude kommuniziert ausschließlich über GraphQL.

Keine direkte Datenbankkommunikation.

---

## Embeddings

Lokale Modelle:

* bge-small-en-v1.5
* bge-base
* nomic-embed-text
* all-MiniLM

Keine Cloud APIs.

---

## Programmiersprache

TypeScript

Node.js LTS

---

# 6. Datenmodell

## Node Types

### Project

Beschreibt ein Projekt.

Attribute:

* id
* name
* description
* createdAt
* updatedAt

---

### Component

Beschreibt eine technische Komponente.

Beispiele:

* Service
* API
* Frontend
* Worker
* Library

Attribute:

* id
* name
* type
* description

---

### File

Repräsentiert eine Datei.

Attribute:

* id
* path
* language
* checksum

---

### Directory

Repräsentiert einen Ordner.

Attribute:

* id
* path

---

### GitCommit

Repräsentiert einen Commit.

Attribute:

* id
* hash
* author
* timestamp
* message

---

### Knowledge

Allgemeines Projektwissen.

Attribute:

* id
* title
* content
* tags
* importance

---

### Decision

ADR (Architecture Decision Record).

Attribute:

* id
* title
* problem
* decision
* reasoning
* alternatives
* date

---

### Experience

Gelernte Erfahrung.

Attribute:

* id
* problem
* solution
* outcome
* confidence

---

### ReviewFinding

Code Review Erkenntnisse.

Attribute:

* id
* severity
* category
* rule
* example
* fix
* frequency

---

### CodingStandard

Projektregel.

Attribute:

* id
* name
* description
* examples

---

### Problem

Bekanntes Problem.

Attribute:

* id
* title
* description

---

# 7. Relationship-Modell

## Projektstruktur

```text
(Project)-[:CONTAINS]->(Component)

(Project)-[:CONTAINS]->(Directory)

(Directory)-[:CONTAINS]->(File)
```

---

## Architektur

```text
(Component)-[:USES]->(Component)

(Component)-[:CALLS]->(Component)

(Component)-[:DEPENDS_ON]->(Component)
```

---

## Entscheidungen

```text
(Decision)-[:AFFECTS]->(Component)

(Decision)-[:REPLACES]->(Decision)

(Decision)-[:IMPLEMENTS]->(Knowledge)
```

---

## Review Findings

```text
(ReviewFinding)-[:AFFECTS]->(Component)

(ReviewFinding)-[:AFFECTS]->(File)

(ReviewFinding)-[:VIOLATES]->(CodingStandard)
```

---

## Erfahrungen

```text
(Experience)-[:SOLVES]->(Problem)

(Experience)-[:RELATES_TO]->(Component)
```

---

## Git

```text
(GitCommit)-[:MODIFIES]->(File)

(GitCommit)-[:IMPLEMENTS]->(Decision)

(GitCommit)-[:FIXES]->(ReviewFinding)
```

---

# 8. GraphQL API

## Query

### Search

```graphql
query {
  search(
    query: "UserService Refactoring"
    limit: 20
  ) {
    nodes
    edges
    score
  }
}
```

---

### Context

```graphql
query {
  context(
    query: "Implement OAuth"
  ) {
    summary
    decisions
    findings
    architecture
    experiences
  }
}
```

---

### Component Lookup

```graphql
query {
  component(
    name: "UserService"
  ) {
    decisions
    dependencies
    findings
    experiences
  }
}
```

---

# 9. Retrieval Pipeline

## Ablauf

```text
Prompt
 ↓
Intent Analysis
 ↓
Embedding Generation
 ↓
Semantic Search
 ↓
Graph Traversal
 ↓
Relationship Expansion
 ↓
Ranking
 ↓
Context Builder
 ↓
Claude Code
```

---

# 10. Ranking

## Formel

```text
score =
semantic_similarity * 0.40
+
graph_relevance * 0.25
+
importance * 0.15
+
usage_count * 0.10
+
recency * 0.10
```

---

# 11. Priorisierung

Reihenfolge:

1. Review Findings
2. Coding Standards
3. Entscheidungen
4. Architekturwissen
5. Erfahrungen
6. Projektwissen

---

# 12. Context Builder

Ziel:

Maximal relevante Informationen liefern.

Aufgaben:

* Duplikate entfernen
* Ähnliche Erkenntnisse zusammenführen
* Priorisieren
* Zusammenfassen
* Tokenbudget einhalten

---

# 13. Review Learning System

## Ziel

Claude soll identische Fehler möglichst nicht erneut erzeugen.

Speicherung:

* Problem
* Ursache
* Regel
* Fix
* Beispiele

Bei Retrieval haben Review Findings höchste Priorität.

---

# 14. Automatisches Lernen

Nach jeder Claude-Antwort erfolgt Analyse.

Mögliche neue Erkenntnisse:

* Neue ADR
* Neue Erfahrung
* Neue Regel
* Neues Review Finding

Falls erkannt:

```text
Antwort
 ↓
Knowledge Extractor
 ↓
Graph Update
```

---

# 15. Embedding-System

Jeder relevante Node besitzt:

* embedding
* embedding_model
* embedding_version

Embeddings werden lokal erzeugt.

---

# 16. Performance-Anforderungen

Suche:

≤ 100 ms

Graph Traversal:

≤ 50 ms

Context Generation:

≤ 250 ms

Memory-Größe:

100.000+ Nodes

1.000.000+ Edges

---

# 17. Sicherheit

Anforderungen:

* Vollständig lokal
* Keine Telemetrie
* Keine Cloud
* Keine Tracking-Daten
* Verschlüsselbarer Speicher
* Backup-Funktion

---

# 18. Speicherort

Standard:

```text
~/.claude-memory/
```

Projektbezogen:

```text
.project-memory/
```

---

# 19. MVP Pflichtumfang

## Muss

* Kuzu Graph Database
* GraphQL API
* Semantic Search
* Embeddings
* Projektwissen
* Architekturwissen
* ADRs
* Erfahrungen
* Review Findings
* Coding Standards
* Relationship Management
* Graph Traversal
* Context Builder
* Retrieval vor jedem Prompt
* Automatische Wissensaktualisierung

---

# 20. Erfolgskriterien

Das System gilt als erfolgreich wenn:

1. Claude frühere Review Findings berücksichtigt.
2. Architekturentscheidungen dauerhaft erhalten bleiben.
3. Wissensbeziehungen korrekt navigiert werden.
4. Projektkontext automatisch bereitgestellt wird.
5. Der benötigte Prompt-Kontext deutlich reduziert wird.
6. Die Qualität der generierten Lösungen über die Zeit steigt.
7. Wiederholte Fehler signifikant reduziert werden.

---

# 21. Zukunft (Version 2)

Geplante Erweiterungen:

* Multi-Projekt Graph
* Wissenskonsolidierung
* Visual Graph Explorer
* Team Sharing
* Lokale LLM-Integration
* Agent-basierte Wissenspflege
* MCP Server Integration
* VS Code Extension
* GitHub Integration
* Cross-Project Knowledge Transfer

---

# Ende des Dokuments

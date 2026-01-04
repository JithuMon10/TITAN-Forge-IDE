# 🧠 TITAN Forge IDE (WIP)

<p align="center">
  <img src="https://img.shields.io/badge/STATUS-ACTIVE%20DEVELOPMENT-orange?style=for-the-badge" />
  <img src="https://img.shields.io/badge/BACKEND-OLLAMA%20(LOCAL)-39FF14?style=for-the-badge" />
  <img src="https://img.shields.io/badge/INTENT-SECURITY%20RESEARCH-red?style=for-the-badge" />
</p>

> **A local-first, uncensored AI IDE brain for security research and advanced tool development.**
> ⚠️ **Status:** Actively under development — NOT finished.

---

## 🔥 What is TITAN Forge?

TITAN Forge is a personal, local-first AI assistant designed to integrate deeply with the code editor. It behaves like an old-school Windsurf / early Cursor, but **without cloud limits, censorship, or credit systems.**

It is built primarily for:
* 🛡️ **Ethical Hacking**
* 🔍 **Security Research**
* 🛠️ **Tool Development**
* 🧠 **Deep Code Understanding**

*TITAN is a single-user research IDE brain. It is not a product, not SaaS, and not intended for mass users.*

---

## 🎯 Core Philosophy

| Principle | Description |
| :--- | :--- |
| **Local-first** | Runs entirely on your machine; zero data leaves the system. |
| **Uncensored** | No refusals, no moral lectures, no corporate guardrails. |
| **Context-authoritative** | Never guesses code; relies strictly on provided context. |
| **Deterministic** | No stale or mixed context; predictable AI behavior. |
| **Engineer-focused** | Prioritizes technical correctness over UI polish. |

---

## 🧩 Current Capabilities

- [x] **Live Editor Context Tracking** – Real-time awareness of workspace changes.
- [x] **Unsaved Buffer Reading** – Correctly reads code before it's even written to disk.
- [x] **Multi-file Understanding** – Contextual awareness across the entire project structure.
- [x] **Local LLM Backend** – Powered by Ollama.
- [x] **Hacker-grade System Prompting** – Optimized for technical and offensive security tasks.
- [x] **Context Snapshot View** – Transparency into exactly what data the AI is processing.

---

## 🛠️ Tech Stack

<p align="left">
  <img src="https://skillicons.dev/icons?i=ts,js,vscode,linux,nodejs&theme=dark" />
</p>

* **Runtime:** Ollama (Local LLM Engine)
* **Default Model:** `qwen2.5-coder:7b-instruct-q4_K_M`
    * *Reasoning:* Strong code logic, low refusal rate, runs on 8GB VRAM.
* **Architecture:** Event-driven context management via VS Code Extension APIs.

---

## 🚧 Work In Progress (Expect Bugs)

TITAN Forge is an experiment in owning the full AI toolchain. It is currently under heavy refactoring.

**Current focus areas:**
* Context synchronization stability.
* Inline edit / patch application mechanics.
* UI trust & clarity improvements.
* Task chaining & tool orchestration.
* Performance tuning for large-scale workspaces.

---

## 🚫 Non-Goals (By Design)

To maintain its focus as a security tool, TITAN Forge does **NOT** aim to be:
* A commercial product or cloud service.
* A general-purpose chat app or beginner-friendly IDE.
* A replacement for enterprise-grade IDEs.

---

## 🧭 Roadmap

- [ ] Harden context authority engine  
- [ ] Stable inline edit support  
- [ ] Tool execution framework  
- [ ] Self-hosted workflow usability  
- [ ] Dogfooding: Using TITAN to build TITAN  

---

## ⚠️ Usage Notice

This project is designed for **authorized security research only.**
* The AI is intentionally uncensored.
* No safeguards are enforced at runtime.
* **You are solely responsible for your actions and the code generated.**

---

## 🤝 Contributions & License

* **Contributions:** This is currently a personal research project. Public contributions are not open yet.
* **License:** To be finalized once the architecture stabilizes.

---
<p align="right">
  <i>"TITAN Forge exists because modern AI IDEs hide context, impose limits, and break trust."</i>
</p>

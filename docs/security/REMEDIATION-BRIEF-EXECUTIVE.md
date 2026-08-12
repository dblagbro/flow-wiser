# Flow-Wiser Security Remediation Brief

**Executive summary · 2026-08-10 · Flow-Wiser 3.1.4-fw10**

---

## The situation in one paragraph

Flowise, the open-source AI workflow platform this product is built on, was **abandoned by its
maintainers on 2026-08-03 and its repository archived on 2026-08-10**. It will never receive another
security patch. Anyone still running Flowise — or a fork of it that has not been actively maintained
— is running software with publicly documented, permanently unfixed vulnerabilities.

Flow-Wiser is a continuation of that codebase under a fully open licence. This brief documents what
we found when we audited it against every security advisory ever published against its parent, what
we fixed, and what remains open.

---

## What we did

We took the complete list of **116 security advisories** published against upstream Flowise —
28 rated Critical, 64 High, 24 Medium — and checked every one of them, individually, against our
current code.

Not a scanner. Not a sample. All 116, each traced to the specific line of code it concerns.

## What we found

|        |                                                                                                            |
| ------ | ---------------------------------------------------------------------------------------------------------- |
| **81** | Already fixed in the version we forked from                                                                |
| **23** | Cannot affect us — the vulnerable code was deleted when we replaced the commercial components with our own |
| **6**  | Already fixed by our own rewrite                                                                           |
| **4**  | **Still present. Now fixed.**                                                                              |
| **2**  | Mitigated but not eliminated — see "What is still open"                                                    |

**Four live vulnerabilities were inherited and nobody had noticed.** Two of them required no login
at all. One was confirmed working against our own production server before we closed it.

---

## The four, in plain terms

### 1. Anyone on the internet could spend money on your AI accounts

**What it was.** A feature that turns chat replies into speech had a gap. Normally it checks that the
conversation is public before doing anything. But if the request simply _left out_ which conversation
it referred to, that check was skipped entirely — and the request could then name any stored
credential by its ID.

**What that meant in practice.** A stranger, with no account and no password, could send a single
request naming one of your stored OpenAI or ElevenLabs keys, and the server would decrypt that key
and use it. Your bill. Their text. Repeatedly.

We confirmed this against our live server: the request succeeded and speech synthesis began, with no
credentials of any kind.

**How we fixed it.** Choosing a credential directly is now treated as what it is — an administrative
action. It requires being signed in, and the credential must belong to your own workspace. The
legitimate case, a public chat widget speaking a public conversation, is untouched.

### 2. An attacker could take over your connected accounts

**What it was.** When you connect Flow-Wiser to an outside service — Google, HubSpot, Microsoft — a
short handshake happens in your browser. Part of that handshake is a value the industry calls a
"state" token, whose entire purpose is to be unguessable, so that only the person who _started_ the
connection can finish it.

Ours was not unguessable. It was the credential's own ID number.

**What that meant in practice.** Someone who knew or guessed that ID could start a connection using
**their own** Google account, and have the resulting access written onto **your** credential. Your
workflows would then be operating as them. A related endpoint let an unauthenticated stranger force
your access tokens to be rotated, breaking your integrations at will.

**How we fixed it.** The state token is now a genuinely random 128-bit value, issued only to someone
already signed in, tied to the specific credential and workspace, usable exactly once, and expiring
in ten minutes. The token-refresh endpoint now requires you to be signed in and to own the
credential.

### 3. The AI could be talked into attacking your internal network

**What it was.** One workflow component lets the AI construct a web address and fetch it. There is a
protective layer that blocks internal addresses — cloud metadata services, internal servers, the
machine itself — and it was correctly applied to one half of this component. The other half was
still using an unprotected fetch.

**What that meant in practice.** A user's message could be crafted to steer the AI into requesting an
internal address that should never be reachable from outside — and because the result is fed back
into the AI's answer, the attacker gets to _read_ the response. Cloud environments expose credentials
at exactly such an address.

**How we fixed it.** Both halves now route through the protective layer, which resolves the address,
checks it against a block list, re-checks it at every redirect, and pins the verified address so it
cannot be swapped mid-request.

### 4. A privileged user could reach outside their own tenant

**What it was.** An import feature built a database query by pasting values from the uploaded file
directly into it — the classic SQL injection pattern. Two sibling features had been fixed for this;
this one was missed.

**What that meant in practice.** An administrator of one workspace could craft an import file that
read or modified data belonging to a different workspace.

**How we fixed it.** Two independent defences: the values must be well-formed identifiers, and they
are passed to the database as parameters rather than pasted into the query. Either alone would close
it; we applied both because they fail in different ways.

---

## What is still open

We are publishing this section deliberately. A security document that lists only good news is not
evidence of anything.

**The code sandbox.** Flow-Wiser lets users write small pieces of code inside a workflow. These run
inside a sandbox called `vm2`, which the wider industry has deprecated — its own author withdrew it
after concluding its escapes could not be reliably closed.

We have hardened it substantially, and an independent security team confirmed that all four publicly
published escape techniques fail against our configuration. But that is configuration, not
architecture, and a future technique might not depend on the same building blocks.

**There is a complete answer available today:** a single setting, `CODE_EXECUTION_MODE=disabled`,
removes the capability entirely. Any deployment whose workflows do not use code blocks should set it.
A second setting runs code on a separate isolated machine instead. Neither is the default, because
switching either on would break existing workflows without warning — that is a decision for the
operator, and this brief exists so it can be made knowingly.

A small number of lower-severity items — accessibility contrast on one button colour, a review
requirement that needs enabling in our source-control settings — are tracked publicly in our issue
register.

---

## Independent verification

An external security team assessed this product on two occasions during the remediation period.

Their first assessment found a **critical, unauthenticated remote code execution chain** and a second
flaw allowing workflows to be run without a key. Both were fixed and re-verified.

Their retest confirmed every prior finding closed and raised seven new items, all since addressed.

**We should be precise about one thing:** two statements in that retest were factually incorrect —
it reported that the deprecated sandbox had been removed from our container and that the isolated
execution mode was active. Neither was true at the time, and we verified this ourselves rather than
accepting a favourable finding. Their conclusions still held, but one rested on a false premise.

We report that because a security brief that launders a third party's name into an endorsement is
worth nothing. Their findings were valuable precisely because they were adversarial.

---

## Why this is a stronger position than the alternative

|                                          | Upstream Flowise                                   | Flow-Wiser 3.1.4-fw10                |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------ |
| Maintenance status                       | **Archived 2026-08-10**                            | Actively maintained                  |
| The four issues above                    | **Unfixed, permanently**                           | Fixed and verified in production     |
| Advisory review                          | None                                               | All 116, published with evidence     |
| Licence                                  | Open core — key components commercially restricted | **100% Apache 2.0**, redistributable |
| Authentication, roles, audit, encryption | Commercially licensed components                   | Rebuilt from scratch, open           |
| External assessment                      | —                                                  | Two rounds, findings published       |

The claim we are making is not "this product has no vulnerabilities." No one can honestly make that
claim about any software.

The claim is narrower and checkable: **every publicly known vulnerability in this product's lineage
has been examined individually, the results are published including the uncomfortable ones, and the
four that were still live have been fixed and verified in production.** Upstream cannot say that, and
never will again.

---

_Full technical detail, including the specific code changes and how to reproduce every finding, is in
the companion engineering brief. The complete 116-row advisory table is published in the source
repository at `docs/ADVISORY-SWEEP.md`._

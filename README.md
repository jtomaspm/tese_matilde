# Método

Método is a European Portuguese web application for academic health research. Researchers configure tests, issue shared invitations, and review descriptive statistics. Participants enter their name and email, complete the assigned test in the browser, and receive confirmation once their responses have been saved.

## Run with Docker

From this directory, build the image once and start the app with one `docker run` command.

```sh
docker build -t metodo-estudo .
docker run -d --name metodo-estudo -p 127.0.0.1:3000:3000 \
  -v metodo-dados-estudo:/data metodo-estudo
```

The Node.js process creates the SQLite database, tables, and two reference tests at startup. The named volume retains the data and admin password when the container is replaced. SQLite runs inside the same container as the web app.

On a system using Docker Desktop's separate context, add `--context desktop-linux` immediately after `docker` if your default context points to a stopped engine.

### First study

1. Open [the homepage](http://127.0.0.1:3000/). The public page explains the project and how participation works.
2. Select **Área de investigação** in the homepage header or open [the researcher area](http://127.0.0.1:3000/admin). On a fresh database, choose any nonempty admin password up to 256 characters. Subsequent visits use that password.
3. Select one of the two included tests or choose **Criar teste**. The builder supports Go / No-Go, Stop Signal, and questionnaires with choice, numerical rating, or open-text questions. Configure the task and add your study's participant information and instructions.
4. In **Convites**, enter a required reference and select **Gerar ligação**. Share the link with multiple participants. Every link accepts unlimited completions until deactivated. The **Testes** menu on the homepage lists available links with the exact reference **Website**. The two default tests each receive an unlimited Website link. Participants can reopen a link after an abandoned session. Researchers can deactivate an invite at any time. **Convites** shows 8 invitations per page, newest first.
5. Open **Resultados** to view counts, condition-level accuracy and reaction times, or questionnaire response distributions. The CSV export includes one row per trial or question for the selected test. The **Participantes** tab shows the names and email addresses of participants with completed submissions.

Use the three-dot menu beside a test name to edit or delete it. Edits apply to new invitations. Existing links and submissions keep the configuration used for that invitation. Use **Criar teste** to run a protocol separately and keep its results independent. Deleting a test removes it from the library and disables its links while retaining its records in SQLite. The CSV uses participant identifiers in place of the name and email fields. Open-text answers may contain identifiers supplied by participants.

Use **Conta → Alterar palavra-passe** in the admin header to change your password. Enter the current password and confirm the new one. The browser you use to make the change stays signed in, and other sessions end. **Conta → Terminar sessão** signs out of the current session.

### Access from other computers

The command above binds the app to your own computer. For participant recruitment, use the institution's HTTPS hostname and keep the Node port behind its reverse proxy. Run with `-e SECURE_COOKIES=1` when serving HTTPS and set `SETUP_TOKEN` before exposing a fresh instance so the first admin password can only be created by someone with that setup token. Generate invitations while viewing the admin page at the hostname participants can reach. The database volume and its backups contain identifiable participant records. Use the study's approved participant information and data handling procedures.

On a Tailscale host, append `-p 127.0.0.1:80:3000 -p "$(tailscale ip -4):80:3000"` before the image name in the Docker command to use the standard HTTP port on localhost and the host's Tailscale IPv4 address. Open the host's MagicDNS name with `http://` from another device on the tailnet. For HTTPS and automatic browser clipboard access, use Tailscale Serve on port 443 after enabling it in the tailnet. [Tailscale Serve documentation](https://tailscale.com/docs/reference/tailscale-cli/serve)

### Run directly with Node.js

```sh
node server.mjs
```

Use Node.js 24 or newer. The app uses Node's bundled HTTP and SQLite modules, so there are no packages to install. The native process uses `./data` by default. You can override `DATA_DIR`, `HOST`, and `PORT`. `GET /api/health` is used by the container health check.

## Reference protocols

The supplied scripts named external image files. The included versions use Portuguese text, arrows, and a fixation cross drawn by the browser. In Go / No-Go, a tap or click anywhere in the stimulus area is scored as the configured response key. In Stop Signal, the left and right halves are scored as the configured left and right keys. Participants can also use a keyboard.

| Reference | Included implementation |
| --- | --- |
| [prog1.txt](reference/prog1.txt) | One randomized block of 20 Go and five No-Go trials. Press Space on Go within 2,000 ms. A Go omission or a No-Go key press produces feedback for 2,000 ms. The default intertrial interval is 500 ms. |
| [prog2.txt](reference/prog2.txt) | A directional B/N baseline ends at 20 consecutive correct trials or 50 attempts. The second block randomizes 30 Go and 10 stop trials. The default response window is 500 ms. The delay for a potential stop cue is drawn from 100–450 ms in 50 ms increments. Preparation is 500 ms, followed by the 500 ms fixation sequence, and the intertrial interval is 750 ms. |

For the supplied Stop Signal variant, a correct directional response before the cue ends the trial and counts as correct. A response after a shown cue counts as an error. Withholding once the cue is shown counts as correct. The baseline feedback computes the mean of actual correct reaction times. The reference's feedback expression points to different columns than its Go save statement. Feedback text is displayed continuously for the equivalent duration of the missing feedback images.

The trial CSV includes the configured response window, pressed key, correctness, and timing flag. The Stop Signal export also includes stimulus direction, assigned and observed stop delay, and response phase. The `rt_ms` field records time from the initial stimulus to a key press, including incorrect presses. Both `key` and `rt_ms` are blank when no key was pressed. The dashboard and **CSV de tempos** report counts, mean, median, minimum, and maximum reaction times both for all recorded key presses and for correct responses only. Import the CSV with a comma separator and a period as the decimal separator.

Stop Signal shows an explicit transition after the practice phase. Both phases are saved in one submission after the second phase. A stop trial in which the browser missed the cue and no key was pressed is flagged and left unscored. Other flagged trials retain their scores. The dashboard calculates accuracy over scorable trials. The Stop Signal variant requires a study-specific analysis plan for any inference about inhibition.

## PsyToolkit and the study design

PsyToolkit keeps the experiment definition separate from the participant invitation, supports reusable scripts and browser demos, and exports trial-level reaction times, conditions, errors, and timeouts. That workflow influenced the configurable tests, participant links, and CSV in this app. Combining cognitive tasks with questionnaires can support consistent remote assessment in academic research. [PsyToolkit features](https://psytoolkit.org/features.html) · [Experiment library](https://www.psytoolkit.org/experiment-library/) · [Example trial export](https://www.psytoolkit.org/experiment-library/stroop.html)

A PsyToolkit replication study recovered effects for response choice and reaction time in one psycholinguistic paradigm. Research using external timing hardware also found variation among browsers, devices, and operating systems. Pilot the stimulus display, key mappings, and timing on the computers planned for the study, especially when analyzing small reaction-time differences. The presets collect research measurements and have no clinical norms, diagnostic cutoffs, or independent calibration. [Kim et al., 2019](https://doi.org/10.1371/journal.pone.0221802) · [Anwyl-Irvine et al., 2021](https://pmc.ncbi.nlm.nih.gov/articles/PMC8367876/) · [Stop-signal consensus guide](https://doi.org/10.7554/eLife.46323)

## Implementation and verification

1. Translated the reference protocols into validated, configurable test definitions in [lib/protocol.mjs](lib/protocol.mjs).
2. Implemented first-run password setup with scrypt, admin sessions, the test library, and invitation redemption in [server.mjs](server.mjs). [lib/database.mjs](lib/database.mjs) initializes SQLite.
3. Built the three Portuguese pages. [public/engine.js](public/engine.js) presents cues and captures keyboard input in the browser using a monotonic clock. [lib/results.mjs](lib/results.mjs) validates and scores the responses on the server and builds the descriptive statistics and CSV.
4. Tested password setup, sign-in, protocol scoring, editing tests with existing invitations, duplicate submissions, disabled invitations, and CSV export with synthetic data. The short Go / No-Go browser check exercises stimulus rendering and keyboard response capture. Timing validation against physical equipment was outside the software check.

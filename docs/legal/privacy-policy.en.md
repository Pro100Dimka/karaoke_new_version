# A&D Voice Privacy Policy

Draft version: 0.3 dated 26 November 2026.

> DRAFT FOR PUBLICATION PREPARATION. No effective date has been set. Before publication, complete bracketed fields and establish actual retention periods, recipients, processing countries and legal bases. Request handling and deletion procedures must work in practice. Remove this editorial note before publication. Describing current behaviour does not certify compliance with every country's requirements.

## 1. Who is responsible

Андреєв Дмитро Ігорович (DMYTRO ANDREIEV), referred to as the Owner, is responsible for personal-data processing within the A&D Voice features provided by the Owner.

- Legal status: individual.
- Country of operation and contact address: [SPECIFY].
- Privacy and deletion enquiries: dmytro.andreiev.dev@gmail.com.
- Official policy page: [SPECIFY URL].
- Effective date: [SPECIFY DATE].
- Data protection representative or officer, if legally required: [SPECIFY OR REMOVE AFTER CHECKING APPLICABILITY].

This policy covers local and network features. It does not replace independent external services' notices; using those services does not remove the Owner's own obligations.

## 2. Data processed

### 2.1. Account and social features

Automatic access and online features use an account identifier, access secret and derived device or participant identifiers. The server may also store display names, avatars, friend codes, account transfer codes, friendships, requests, invitations, last activity and room participation history.

The random secret is held in the current user's Windows Credential Manager. Authentication transmits it to the service over a protected control connection; the server uses its hash to identify the account. During migration, the previous credential derived from a Windows identifier or fallback computer name is used to preserve the existing account automatically.

The secret and transfer code are access credentials. They must not appear in public messages or ordinary support requests.

### 2.2. Music files and processing results

The device processes selected audio and video files, song names and metadata, images, lyrics, notes, project settings, performance recordings and processing results. Local mode performs the main computation on the device.

This does not make the application fully offline: recognition, lyrics and video search, updates, diagnostics and rooms may access the network independently of local computation mode.

When radio or clip downloads are used, the device contacts YouTube/Google and media delivery servers directly. Those recipients receive the IP address, requested video or playlist identifiers and technical request information. Ordinary local retrieval does not require audio or video to pass through the Owner's server. A saved clip may be included in an ordinary project export, but is excluded from the archive the current client prepares for a room. The project carries the original link instead, allowing participants to retrieve the clip directly from the external service. Other project material, voice, logs and activity information may be transmitted through the separately described features.

### 2.3. Microphone, rooms and recordings

Relevant features capture sound from the selected microphone. In an online room, voice is sent to a central server for processing and mixing before being delivered to other participants.

Depending on the selected recording and subsequent processing scenario, individual participant tracks, performance timestamps, participant information and project material may be transmitted and temporarily stored. Results available to participants may remain on their devices.

### 2.4. Technical information and diagnostics

Network operations may process IP addresses, client and room identifiers, timestamps, application and operating system versions, audio-device information, errors, latency, packet loss and processing state.

The current version automatically sends application and service text logs to the server. Messages may include filenames, paths, job information and error content. Some secrets and usernames in paths are masked, but not every message is fully anonymised.

Ordinary text diagnostics are not continuous audio recording. Audio and file transfers for rooms, recording and remote processing are described separately above.

### 2.5. User enquiries

Support processes contact details, enquiry text, files supplied by the user and information needed to respond. Do not send passport details, passwords, the account secret or transfer code unless a specific lawful procedure requires them and provides a secure transmission method.

## 3. Purposes

Data is used to provide selected features: account access and recovery, profiles and friends, invitations and room history, music and recording processing, voice transmission, compatibility, updates, troubleshooting, abuse prevention and responding to enquiries.

Permission to use music material is limited to the selected functions. This policy does not grant the Owner a right to sell user material or use it in advertising.

## 4. Legal bases

Depending on applicable law and the operation, potential bases include performance of a contract or steps requested before entering it, compliance with legal obligations, consent where required, and legitimate interests in security and service maintenance where permitted and after assessing their balance against user rights.

Optional operations that require consent must request it separately before processing begins, with an option to refuse and withdraw. Reading this policy or accepting the terms does not replace that consent.

[BEFORE PUBLICATION: assign a specific basis to each operation, separately assess automatic diagnostic uploads and the Discord integration enabled by default. If consent is required, change application behaviour before publication rather than declaring consent obtained through this text.]

## 5. Recipients

Access is limited to what the relevant feature needs:

- The Owner and authorised technical providers maintaining the application or responding to enquiries.
- Infrastructure providers, including the Oracle Cloud infrastructure used, and the remote processing computer operator.
- Other room participants: displayed information, voice, shared material and recording results available to them.
- External services used by selected or enabled features.
- Competent authorities where disclosure is legally required and has an appropriate basis.

The current code supports these external requests:

| Feature | Possible recipient and data |
| --- | --- |
| Song identification | Shazam: acoustic features and technical request data; AudD, if configured: the submitted audio file and request information |
| Lyrics search | LRCLIB: song title, artist and search parameters |
| Video search and retrieval, radio | YouTube/Google and media providers: requests, content identifiers and connection information |
| Application updates | GitHub: release and file requests and technical connection information; the application version is used in update-check logic |
| Model and component downloads | Distribution servers: requests for required files and technical connection information |
| Discord activity | The installed Discord client: application state, song or radio programme title and room size, depending on the scenario |

Availability does not imply official endorsement by a provider. Active recipients depend on settings and the application release.

[BEFORE PUBLICATION: identify the legal entities operating the server and worker, current links to external notices, their processing roles and the file providers used.]

## 6. Processing locations

Local data is processed on the user's device. Network features use server infrastructure and, for remote processing, a separate processing computer.

Main locations: [SPECIFY COUNTRIES AND REGIONS OF THE SERVER, WORKER AND BACKUPS]. Recipients may be in countries with different data protection rules.

Where international transfer requirements apply, legally recognised grounds and safeguards must be used. Actual mechanism and how to obtain information about safeguards: [SPECIFY THE ACTUAL MECHANISM; DO NOT CLAIM AGREEMENTS THAT HAVE NOT BEEN CONCLUDED].

## 7. Retention

| Category | Retention approach |
| --- | --- |
| Local songs, projects, recordings and settings | Until user deletion or uninstallation according to its warning; exported copies may remain elsewhere |
| Windows account secret | Kept independently of the application folder for subsequent access until removed from the credential store or Windows user data is lost |
| Account, friends and room history | Kept to provide and restore the account until deletion; inactive-account retention and request procedure: [DEFINE AND IMPLEMENT] |
| Files on the remote-processing server | Current implementation expires them 24 hours after job creation and removes them during the next cleanup; cancelled jobs may be deleted sooner |
| Temporary worker data | The full job's temporary library is removed after sending results; reusable partial-reprocessing sessions are cleaned under a 24-hour and size-limit policy when cleanup runs |
| Room project material | Removed when the room is deleted or orphaned files are found during cleanup |
| Separate performance tracks on the server | Cleanup uses 24 hours from the server's performance-activity timestamp; removal occurs during the next cleanup pass |
| Separate room diagnostic files | Current cleanup policy uses seven days; some messages also enter the general log |
| General server application log | Currently size-limited and rotated, without a fixed time-based deletion period. Before publication: [SET A PERIOD AND IMPLEMENT CLEANUP] |
| Support enquiries and backups | [SPECIFY RETENTION PERIODS AND CRITERIA, INCLUDING REMOVAL OF DELETED DATA FROM BACKUPS] |

Temporary-file expiry does not guarantee deletion at the exact second: it depends on cleanup services. The Owner must keep them running and address retention failures.

Where law requires longer retention of specific information, only the necessary information is kept for the applicable period. Server deletion does not delete participant-held copies.

## 8. User choices and settings

Users may choose local or available remote processing, avoid joining rooms, mute the microphone through relevant controls, delete local material and manage microphone access through Windows.

Discord activity is controlled by the setting for showing singing activity in Discord. In the current version it is enabled by default and may operate when Discord is running. A separate setting controls automatic update installation.

Current server log uploads can be disabled with `AD_VOICE_DISABLE_SERVER_LOGS`; there is no separate user-facing toggle yet. Instructions are available from dmytro.andreiev.dev@gmail.com. Disabling logs does not disable data needed for deliberately used network functions.

Consent-based processing must provide an accessible withdrawal method. Withdrawal does not invalidate lawful processing before withdrawal or prevent operations that have another lawful basis.

## 9. Uninstallation and account recovery

Uninstalling A&D Voice may remove local files but does not request server-account deletion. The access secret remains in Windows to restore the account after reinstallation under the same Windows user.

Account deletion requests go to dmytro.andreiev.dev@gmail.com. Proportionate proof of account control may be needed to prevent deletion of someone else's account. Do not email the Windows secret or transfer code in an ordinary message.

Removing only the Windows secret does not delete the server account. Conversely, server deletion cannot itself remove files from disconnected or other people's devices. Full deletion methods and loss-of-access consequences must be explained when handling requests.

## 10. Security

The application uses separate local profiles, access secrets and server-operation restrictions. Public-server control connections use HTTPS/WSS and Windows protects the account secret. These measures do not mean absolute device or service security.

Current room voice UDP traffic is unencrypted. The server accesses audio to mix voices; participant-to-participant end-to-end encryption is not claimed. This notice does not waive the Owner's duty to provide appropriate security under applicable law.

Incidents or suspected unauthorised access may be reported to dmytro.andreiev.dev@gmail.com. Response and notification duties follow applicable law.

## 11. Rights and enquiries

Depending on applicable law, users may obtain information about processing and access their data, request correction, deletion or restriction, object to particular operations, receive a portable copy, and withdraw consent where it is the processing basis.

Requests go to dmytro.andreiev.dev@gmail.com. Describe the request and provide available nonsecret information sufficient to locate the account. Additional verification is requested only when necessary. Responses follow applicable statutory deadlines; lawful refusals or restrictions are explained.

Users may contact a competent data protection authority or court. For users covered by the GDPR this includes a supervisory authority in applicable cases. In Ukraine, data protection enquiries may be directed to the Ukrainian Parliament Commissioner for Human Rights.

For a child's data or a person requiring a legal representative, verification and handling follow applicable law. [BEFORE PUBLICATION: define the product's age audience and necessary measures.]

## 12. Policy changes

The current version is available at [URL] and in the application. Material changes to purposes, data categories, recipients or processing conditions are communicated before implementation. Separate consent, where required, is requested before the relevant processing begins.

A new policy version does not automatically constitute consent to all new operations.

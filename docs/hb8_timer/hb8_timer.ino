/*
  BASELINE - NICHT DIREKT AENDERN
  ===============================
  Bewaehrte Referenzfirmware fuer den Arduino Mega 2560.
  Firmwarekennung: HB8 Sniffer v4.2, FW_BUILD 20261012.
  Diese Datei dient als Vergleichs- und Wiederherstellungsstand.
  Experimente und Verbesserungen immer in einer Kopie durchfuehren.

  HB8 Sniffer v4.2 — Zustandsbasierte Erkennung
  =============================================
  Rows:    D22(PA0), D23(PA1), D40(PG1), D41(PG0)
  Columns: D24-D39 (PA2-PA7, PC7-PC0, PD7, PG2)

  Timer1 ISR @ 50 kHz: stickyA &= PINA; stickyC &= PINC; etc.
  Loop alle 100 µs: liest Sticky, aktualisiert aktive Masken,
  registriert Treffer bei jeder Änderung der aktiven Kombination.

  Ausgabe: HIT,<ms>,R<r>,C<c>,CODE=...,PTS=...,SEG=...
  Befehle: HELP, STATUS, PING, DIAG, RAW, MAP, START, STOP,
           STREAM ALL/HITS, MODE PROTO/LEGACY, POLARITY LOW/HIGH
*/

#include <avr/io.h>
#include <avr/interrupt.h>
#include <string.h>

#define FW_BUILD 20261012UL

// ═══════════════════════════════════════════════
//  KONFIGURATION
// ═══════════════════════════════════════════════
const uint8_t ROW_COUNT    = 4;
const uint8_t COL_COUNT    = 16;

const uint8_t ROW_PINS[4] = { 22, 23, 40, 41 };
const uint8_t COL_PINS[16] = {
  24,25,26,27,28,29,
  30,31,32,33,34,35,36,37,
  38,39
};

const int16_t SEGMENT_MAP[4][16] = {
  { 212, 112, 209, 109, 214, 114, 211, 111, 208, 108,   0, 312, 309, 314, 311, 308 },
  { 216, 116, 207, 107, 219, 119, 203, 103, 217, 117, 225, 316, 307, 319, 303, 317 },
  { 202, 102, 215, 115, 210, 110, 206, 106, 213, 113, 125, 302, 315, 310, 306, 313 },
  { 204, 104, 218, 118, 201, 101, 220, 120, 205, 105,   0, 304, 318, 301, 320, 305 }
};

const unsigned long HEARTBEAT_MS        = 30000;
const unsigned long HIT_RELEASE_MS      = 100;
const unsigned long HIT_REFRACTORY_MS   = 30;
const unsigned long PAIR_LOCK_MS        = 300;

// ═══════════════════════════════════════════════
//  GLOBALE VARIABLEN
// ═══════════════════════════════════════════════
bool signalActiveLow = true;

// Sticky‑Register (ISR schreibt, Loop liest)
volatile uint8_t  stickyA = 0xFF;
volatile uint8_t  stickyC = 0xFF;
volatile uint8_t  stickyD = 0xFF;
volatile uint8_t  stickyG = 0xFF;
volatile uint32_t isrCount = 0;

// Vorherige aktive Masken für Zustandsänderung
uint8_t  lastActiveRowMask = 0;
uint16_t lastActiveColMask = 0;

// Treffer‑Queue
uint8_t  hitBufR[4];
uint8_t  hitBufC[4];
unsigned long hitBufMs[4];
volatile uint8_t hitHead = 0;
volatile uint8_t hitTail = 0;

// Treffer‑Logik
bool    hitActive = false;
int8_t  lastHitR = -1, lastHitC = -1;
unsigned long lastHitPairMs = 0;
unsigned long lastHitMs = 0;
unsigned long hitCount = 0;
unsigned long pairLock[4][16];

// Statistik (nur für DIAG)
unsigned long rowEdges[4]  = {0};
unsigned long colEdges[16] = {0};

// Serielle Befehle
char    cmdBuf[32];
uint8_t cmdLen = 0;
unsigned long lastCmdMs = 0;
unsigned long lastHeartbeat = 0;

enum OutMode { MODE_PROTO, MODE_LEGACY };
enum StrMode { STR_ALL, STR_HITS };
OutMode outMode  = MODE_PROTO;
StrMode strMode  = STR_HITS;
bool    paused   = false;

// ═══════════════════════════════════════════════
//  HILFSFUNKTIONEN
// ═══════════════════════════════════════════════
inline bool isActive(bool level) {
  return signalActiveLow ? (level == LOW) : (level == HIGH);
}

inline bool readRow(uint8_t pa, uint8_t pg, uint8_t r) {
  if (r == 0) return (pa >> 0) & 1;
  if (r == 1) return (pa >> 1) & 1;
  if (r == 2) return (pg >> 1) & 1;
  return (pg >> 0) & 1;
}
inline bool readCol(uint8_t pa, uint8_t pc, uint8_t pd, uint8_t pg, uint8_t c) {
  if (c < 6)       return (pa >> (c + 2)) & 1;
  if (c < 14)      return (pc >> (7 - (c - 6))) & 1;
  if (c == 14)     return (pd >> 7) & 1;
  return (pg >> 2) & 1;
}

int16_t codeToPoints(int16_t code) {
  if (code <= 0) return 0;
  if (code == 125) return 25;
  if (code == 225) return 50;
  int16_t base = code % 100;
  int16_t mult = code / 100;
  return (base > 0 && mult >= 1 && mult <= 3) ? base * mult : 0;
}

void printSegName(int16_t code) {
  if (code <= 0)       { Serial.print(F("MISS"));     return; }
  if (code == 125)     { Serial.print(F("BULL"));     return; }
  if (code == 225)     { Serial.print(F("BULLSEYE")); return; }
  const char* p[] = {"", "S", "D", "T"};
  Serial.print(p[code / 100]);
  Serial.print(code % 100);
}

bool textEq(const char* a, const char* b) {
  while (*a && *b) { if (*a++ != *b++) return false; }
  return (*a == '\0' && *b == '\0');
}

// ═══════════════════════════════════════════════
//  TREFFER‑QUEUE
// ═══════════════════════════════════════════════
bool pushHit(uint8_t r, uint8_t c, unsigned long ms) {
  uint8_t h = hitHead;
  uint8_t n = (h + 1) & 0x03;
  if (n == hitTail) return false;
  hitBufR[h] = r; hitBufC[h] = c; hitBufMs[h] = ms;
  hitHead = n;
  return true;
}

bool popHit(uint8_t* r, uint8_t* c, unsigned long* ms) {
  if (hitHead == hitTail) return false;
  *r = hitBufR[hitTail]; *c = hitBufC[hitTail]; *ms = hitBufMs[hitTail];
  hitTail = (hitTail + 1) & 0x03;
  return true;
}

// ═══════════════════════════════════════════════
//  TREFFER REGISTRIEREN
// ═══════════════════════════════════════════════
void registerHit(uint8_t r, uint8_t c, unsigned long now) {
  if (now - pairLock[r][c] < PAIR_LOCK_MS) return;
  if (now - lastHitMs < HIT_REFRACTORY_MS) return;

  pairLock[r][c] = now;
  lastHitMs = now;
  hitCount++;
  hitActive = true;
  lastHitR = r; lastHitC = c;
  lastHitPairMs = now;

  if (!pushHit(r, c, now)) {
    uint8_t tr, tc; unsigned long tms;
    if (popHit(&tr, &tc, &tms)) {
      int16_t code = SEGMENT_MAP[tr][tc];
      Serial.print(F("HIT,")); Serial.print(tms);
      Serial.print(F(",R")); Serial.print(tr);
      Serial.print(F(",C")); Serial.print(tc);
      Serial.print(F(",CODE=")); Serial.print(code);
      Serial.print(F(",PTS=")); Serial.print(codeToPoints(code));
      Serial.print(F(",SEG=")); printSegName(code);
      Serial.println();
    }
    pushHit(r, c, now);
  }
}

void flushHits() {
  if (paused) { hitHead = hitTail; return; }
  uint8_t r, c; unsigned long ms;
  while (popHit(&r, &c, &ms)) {
    int16_t code = SEGMENT_MAP[r][c];
    if (outMode == MODE_LEGACY) {
      Serial.print(F("MATRIX R")); Serial.print(r);
      Serial.print(F(" C")); Serial.println(c);
    } else {
      Serial.print(F("HIT,")); Serial.print(ms);
      Serial.print(F(",R")); Serial.print(r);
      Serial.print(F(",C")); Serial.print(c);
      Serial.print(F(",CODE=")); Serial.print(code);
      Serial.print(F(",PTS=")); Serial.print(codeToPoints(code));
      Serial.print(F(",SEG=")); printSegName(code);
      Serial.println();
    }
  }
}

// ═══════════════════════════════════════════════
//  SNAPSHOT VERARBEITUNG (ZUSTANDSBASIERT)
// ═══════════════════════════════════════════════
void processSticky(uint8_t nowA, uint8_t nowC, uint8_t nowD, uint8_t nowG,
                   unsigned long nowMs) {
  // 1) Aktive Pins aus dem Sticky berechnen
  uint8_t  activeRowMask = 0;
  uint16_t activeColMask = 0;
  for (uint8_t r = 0; r < ROW_COUNT; r++)
    if (isActive(readRow(nowA, nowG, r))) activeRowMask |= (1 << r);
  for (uint8_t c = 0; c < COL_COUNT; c++)
    if (isActive(readCol(nowA, nowC, nowD, nowG, c))) activeColMask |= (1u << c);

  // 2) Prüfen, ob sich die aktive Kombination geändert hat
  bool rowChanged = (activeRowMask != lastActiveRowMask);
  bool colChanged = (activeColMask != lastActiveColMask);

  if (rowChanged || colChanged) {
    // Zähle aktive Rows und Cols
    uint8_t rowCnt = 0, colCnt = 0;
    uint8_t rowIdx = 0, colIdx = 0;
    for (uint8_t r = 0; r < ROW_COUNT; r++) if (activeRowMask & (1 << r)) { rowCnt++; rowIdx = r; }
    for (uint8_t c = 0; c < COL_COUNT; c++) if (activeColMask & (1u << c)) { colCnt++; colIdx = c; }

    // Fall A: Genau eine Row und eine Col aktiv → Treffer
    if (rowCnt == 1 && colCnt == 1) {
      registerHit(rowIdx, colIdx, nowMs);
    }
    // Fall B: Eine Row, mehrere Cols – wähle die neu hinzugekommene Col
    else if (rowCnt == 1 && colCnt > 1) {
      uint16_t newCols = activeColMask & ~lastActiveColMask;
      if (newCols != 0) {
        for (uint8_t c = 0; c < COL_COUNT; c++) {
          if (newCols & (1u << c)) {
            registerHit(rowIdx, c, nowMs);
            break;
          }
        }
      }
    }
    // Fall C: Mehrere Rows, eine Col – wähle die neu hinzugekommene Row
    else if (colCnt == 1 && rowCnt > 1) {
      uint8_t newRows = activeRowMask & ~lastActiveRowMask;
      if (newRows != 0) {
        for (uint8_t r = 0; r < ROW_COUNT; r++) {
          if (newRows & (1 << r)) {
            registerHit(r, colIdx, nowMs);
            break;
          }
        }
      }
    }
    // Fall D: Mehrere Rows und Cols – wir nehmen die erste neue Kombination
    else {
      // Hier könnten wir noch komplexer werden, aber für Dart reicht das.
      // Wir ignorieren diesen Fall oder nehmen die erste neue Row und Col.
      uint8_t newRows = activeRowMask & ~lastActiveRowMask;
      uint16_t newCols = activeColMask & ~lastActiveColMask;
      if (newRows != 0 && newCols != 0) {
        uint8_t r = 0, c = 0;
        for (uint8_t i = 0; i < ROW_COUNT; i++) if (newRows & (1 << i)) { r = i; break; }
        for (uint8_t i = 0; i < COL_COUNT; i++) if (newCols & (1u << i)) { c = i; break; }
        registerHit(r, c, nowMs);
      }
    }
  }

  // Hit‑Release‑Logik
  if (hitActive && (nowMs - lastHitPairMs >= HIT_RELEASE_MS)) {
    if (!activeRowMask || !activeColMask) {
      hitActive = false;
      lastHitR = -1; lastHitC = -1;
    }
  }

  // 3) Letzte aktive Masken für nächsten Durchlauf speichern
  lastActiveRowMask = activeRowMask;
  lastActiveColMask = activeColMask;
}

// ═══════════════════════════════════════════════
//  SERIELLE BEFEHLE (unverändert)
// ═══════════════════════════════════════════════
void printStatus() {
  uint32_t cnt;
  cli(); cnt = isrCount; sei();
  Serial.print(F("HB,")); Serial.print(millis());
  Serial.print(F(",hits=")); Serial.print(hitCount);
  Serial.print(F(",isr=")); Serial.print(cnt);
  Serial.print(F(",fw=")); Serial.print(FW_BUILD);
  Serial.print(F(",st="));
  Serial.println((paused ? 1 : 0) | (outMode == MODE_LEGACY ? 2 : 0) | (signalActiveLow ? 0 : 4));
}

void handleCmd() {
  cmdBuf[cmdLen] = '\0';
  if (!cmdLen) return;

  if (textEq(cmdBuf, "HELP")) {
    Serial.println(F("HELP|STATUS|PING|DIAG|RAW|MAP|START|STOP"));
    Serial.println(F("STREAM ALL|STREAM HITS|MODE PROTO|MODE LEGACY"));
    Serial.println(F("POLARITY LOW|POLARITY HIGH"));
  }
  else if (textEq(cmdBuf, "STATUS"))       { printStatus(); }
  else if (textEq(cmdBuf, "PING"))          { Serial.println(F("PONG")); }
  else if (textEq(cmdBuf, "DIAG")) {
    uint32_t cnt;
    cli(); cnt = isrCount; sei();
    Serial.print(F("DIAG isr=")); Serial.print(cnt);
    Serial.print(F(" rows="));
    for (uint8_t r = 0; r < ROW_COUNT; r++) {
      Serial.print('R'); Serial.print(r); Serial.print(':'); Serial.print(rowEdges[r]); Serial.print(' ');
    }
    Serial.print(F("cols="));
    for (uint8_t c = 0; c < COL_COUNT; c++) {
      Serial.print('C'); Serial.print(c); Serial.print(':'); Serial.print(colEdges[c]); Serial.print(' ');
    }
    Serial.println();
  }
  else if (textEq(cmdBuf, "RAW")) {
    uint8_t pa, pc, pd, pg;
    cli(); pa = PINA; pc = PINC; pd = PIND; pg = PING; sei();
    Serial.print(F("PINA=0x")); Serial.print(pa, HEX);
    Serial.print(F(" PINC=0x")); Serial.print(pc, HEX);
    Serial.print(F(" PIND=0x")); Serial.print(pd, HEX);
    Serial.print(F(" PING=0x")); Serial.println(pg, HEX);
    for (uint8_t r = 0; r < ROW_COUNT; r++) {
      Serial.print(F("R")); Serial.print(r); Serial.print(F("="));
      Serial.println(isActive(readRow(pa, pg, r)) ? F("ACTIVE") : F("idle"));
    }
    for (uint8_t c = 0; c < COL_COUNT; c++) {
      Serial.print(F("C")); Serial.print(c); Serial.print(F("="));
      Serial.println(isActive(readCol(pa, pc, pd, pg, c)) ? F("ACTIVE") : F("idle"));
    }
  }
  else if (textEq(cmdBuf, "MAP")) {
    Serial.println(F("MAP SEGMENT_MAP[Row][Col]:"));
    for (uint8_t r = 0; r < ROW_COUNT; r++) {
      Serial.print(F("R")); Serial.print(r); Serial.print(F(" "));
      for (uint8_t c = 0; c < COL_COUNT; c++) {
        int16_t v = SEGMENT_MAP[r][c];
        if (v < 100) Serial.print(F("  "));
        else if (v < 1000) Serial.print(F(" "));
        Serial.print(v); Serial.print(F(" "));
      }
      Serial.println();
    }
  }
  else if (textEq(cmdBuf, "STREAM ALL"))    { strMode = STR_ALL;    Serial.println(F("OK ALL")); }
  else if (textEq(cmdBuf, "STREAM HITS"))   { strMode = STR_HITS;   Serial.println(F("OK HITS")); }
  else if (textEq(cmdBuf, "START"))         { paused = false;       Serial.println(F("OK START")); }
  else if (textEq(cmdBuf, "STOP"))          { paused = true;        Serial.println(F("OK STOP")); }
  else if (textEq(cmdBuf, "MODE PROTO"))    { outMode = MODE_PROTO; Serial.println(F("OK PROTO")); }
  else if (textEq(cmdBuf, "MODE LEGACY"))   { outMode = MODE_LEGACY;Serial.println(F("OK LEGACY")); }
  else if (textEq(cmdBuf, "POLARITY LOW"))  { signalActiveLow = true;  Serial.println(F("OK LOW")); }
  else if (textEq(cmdBuf, "POLARITY HIGH")) { signalActiveLow = false; Serial.println(F("OK HIGH")); }
  else { Serial.print(F("ERR: ")); Serial.println(cmdBuf); }
}

void pollSerial() {
  unsigned long now = millis();
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\b' || c == 0x7F) { if (cmdLen > 0) cmdLen--; continue; }
    if (c == '\r' || c == '\n') { handleCmd(); cmdLen = 0; lastCmdMs = 0; continue; }
    if (c >= 32 && c <= 126) {
      if (c >= 'a' && c <= 'z') c -= 32;
      if (cmdLen < sizeof(cmdBuf) - 1) cmdBuf[cmdLen++] = c;
    }
    lastCmdMs = now;
  }
  if (cmdLen > 0 && lastCmdMs > 0 && (now - lastCmdMs >= 100)) {
    handleCmd(); cmdLen = 0; lastCmdMs = 0;
  }
}

// ═══════════════════════════════════════════════
//  TIMER1 ISR (50 kHz)
// ═══════════════════════════════════════════════
ISR(TIMER1_COMPA_vect) {
  stickyA &= PINA;
  stickyC &= PINC;
  stickyD &= PIND;
  stickyG &= PING;
  isrCount++;
}

// ═══════════════════════════════════════════════
//  SETUP
// ═══════════════════════════════════════════════
void setup() {
  Serial.begin(500000);
  delay(500);

  for (uint8_t i = 0; i < COL_COUNT; i++) {
    pinMode(COL_PINS[i], INPUT);
    digitalWrite(COL_PINS[i], LOW);
  }
  for (uint8_t i = 0; i < ROW_COUNT; i++) {
    pinMode(ROW_PINS[i], INPUT);
    digitalWrite(ROW_PINS[i], LOW);
  }

  stickyA = 0xFF; stickyC = 0xFF; stickyD = 0xFF; stickyG = 0xFF;
  memset(pairLock, 0, sizeof(pairLock));

  cli();
  TCCR1A = 0; TCCR1B = 0; TCNT1 = 0;
  OCR1A = 319;
  TCCR1B |= (1 << WGM12) | (1 << CS10);
  TIMSK1 |= (1 << OCIE1A);
  sei();

  Serial.println();
  Serial.println(F("=== HB8 SNIFFER v4.2 (zustandsbasiert) ==="));
  Serial.println(F("Rows: D22/D23/D40/D41 | Columns: D24-D39"));
  Serial.println(F("Timer1 ISR 50kHz | INPUT (passiv)"));
  printStatus();
}

// ═══════════════════════════════════════════════
//  LOOP
// ═══════════════════════════════════════════════
void loop() {
  unsigned long nowUs = micros();
  static unsigned long lastProcUs = 0;
  static unsigned long lastSerialCheck = 0;
  static uint8_t warmup = 20;
  const unsigned long PROC_INTERVAL_US = 100;

  if (nowUs - lastProcUs >= PROC_INTERVAL_US) {
    uint8_t sa, sc, sd, sg;
    cli();
    sa = stickyA; stickyA = 0xFF;
    sc = stickyC; stickyC = 0xFF;
    sd = stickyD; stickyD = 0xFF;
    sg = stickyG; stickyG = 0xFF;
    sei();

    if (warmup > 0) {
      // Während Warmup nur die aktiven Masken setzen, keine Treffer
      uint8_t  am = 0; uint16_t cm = 0;
      for (uint8_t r = 0; r < ROW_COUNT; r++) if (isActive(readRow(sa, sg, r))) am |= (1 << r);
      for (uint8_t c = 0; c < COL_COUNT; c++) if (isActive(readCol(sa, sc, sd, sg, c))) cm |= (1u << c);
      lastActiveRowMask = am;
      lastActiveColMask = cm;
      warmup--;
    } else {
      processSticky(sa, sc, sd, sg, millis());
    }
    lastProcUs = nowUs;
  }

  flushHits();

  unsigned long nowMs = millis();
  if (nowMs - lastSerialCheck >= 5) {
    pollSerial();
    lastSerialCheck = nowMs;
  }

  if (nowMs - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = nowMs;
    printStatus();
  }
}
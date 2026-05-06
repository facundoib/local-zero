"""Generate fixtures/test-es.pdf — minimal Spanish PDF for the F1 spike.

Uses Arial.ttf from C:\\Windows\\Fonts\\ (TTF with full Latin-1 supplement,
covers ñ á é í ó ú ü ¿ ¡ and friends). On Linux CI the equivalent path is
DejaVuSans.ttf — the workflow generates its own copy inline.
"""
from fpdf import FPDF
from pathlib import Path

OUT = Path(__file__).parent / "test-es.pdf"

pdf = FPDF()
pdf.add_page()
pdf.add_font("arial", fname=r"C:\Windows\Fonts\Arial.ttf")
pdf.set_font("arial", size=14)

lines = [
    "Curriculum Vitae - María Pérez",
    "Educación: Ingeniería en sistemas con énfasis en algoritmos.",
    "Caracteres clave: ñ á é í ó ú ü ¿ ¡ Ñ Á É Í Ó Ú",
    "Frase: ¿Cuál es tu año de graduación? ¡Sí! María vive en España.",
    "Experiencia: diseño de algoritmos, gestión de equipos pequeños.",
    "Línea con acentos: año, niño, corazón, mañana, sueño.",
    "Idiomas: español nativo, inglés avanzado.",
]
for line in lines:
    pdf.cell(text=line, new_x="LMARGIN", new_y="NEXT", h=10)

pdf.output(str(OUT))
print(f"Wrote {OUT} ({OUT.stat().st_size} bytes)")

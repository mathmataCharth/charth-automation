from __future__ import annotations

import asyncio
import csv
import sys
import time
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import pandas as pd
from playwright.async_api import TimeoutError as PlaywrightTimeoutError
from playwright.async_api import async_playwright


ROOT = Path(__file__).resolve().parent
EXCEL_PATH = ROOT / "prod_lista.xlsx"
CSV_PATH = ROOT / "resultado.csv"
TARGET_URL_FRAGMENT = "charth.appstob.com.br"
CARD_SELECTOR = "app-produto-grid"
NAME_SELECTOR = "h3"
COLOR_SELECTOR = "app-button-cores button[aria-label]"


@dataclass
class ItemConsulta:
    item_original: str
    nome: str
    cor: str


def normalize_text(value: object) -> str:
    text = "" if value is None else str(value)
    text = unicodedata.normalize("NFKC", text)
    text = " ".join(text.replace("\u00a0", " ").split())
    return text.strip().upper()


def split_nome_cor(item_original: str) -> tuple[str, str]:
    raw = "" if item_original is None else str(item_original)
    if " - " in raw:
        nome, cor = raw.rsplit(" - ", 1)
    else:
        nome, cor = raw, ""
    return normalize_text(nome), normalize_text(cor)


def carregar_itens_excel() -> list[ItemConsulta]:
    if not EXCEL_PATH.exists():
        raise FileNotFoundError(f"Arquivo nao encontrado: {EXCEL_PATH}")

    df = pd.read_excel(EXCEL_PATH, dtype=str)
    if df.empty:
        raise ValueError("A planilha esta vazia.")

    selected_column = None
    for column in df.columns:
        series = df[column].dropna().astype(str)
        if series.empty:
            continue
        if series.str.contains(r"\s-\s", regex=True).any():
            selected_column = column
            break

    if selected_column is None:
        selected_column = df.columns[0]

    itens: list[ItemConsulta] = []
    for value in df[selected_column].dropna():
        item_original = " ".join(str(value).split()).strip()
        if not item_original:
            continue
        nome, cor = split_nome_cor(item_original)
        itens.append(ItemConsulta(item_original=item_original, nome=nome, cor=cor))

    if not itens:
        raise ValueError("Nenhum item valido foi encontrado na planilha.")

    return itens


async def encontrar_pagina_catalogo(browser) -> object:
    for context in browser.contexts:
        for page in context.pages:
            if TARGET_URL_FRAGMENT in page.url:
                return page
    raise RuntimeError(
        f"Nao encontrei nenhuma aba com URL contendo '{TARGET_URL_FRAGMENT}'."
    )


async def esperar_cards_iniciais(page) -> None:
    await page.wait_for_load_state("domcontentloaded")
    await page.wait_for_load_state("networkidle")
    await page.wait_for_function(
        f"() => document.querySelectorAll('{CARD_SELECTOR}').length > 0",
        timeout=120000,
    )
    await page.wait_for_timeout(1500)


async def contar_cards(page) -> int:
    return await page.locator(CARD_SELECTOR).count()


async def scroll_ate_fim(page) -> int:
    stable_rounds = 0
    previous_count = -1
    max_rounds = 400

    for round_index in range(1, max_rounds + 1):
        current_count = await contar_cards(page)
        print(f"[scroll] rodada={round_index} produtos={current_count}")

        if current_count == previous_count:
            stable_rounds += 1
        else:
            stable_rounds = 0
            previous_count = current_count

        if stable_rounds >= 6:
            break

        await page.evaluate(
            """
            () => {
                const scrollingElement =
                    document.scrollingElement || document.documentElement || document.body;
                scrollingElement.scrollTo(0, scrollingElement.scrollHeight);
                window.scrollTo(0, document.body.scrollHeight);
            }
            """
        )
        await page.wait_for_timeout(1200)

    final_count = await contar_cards(page)
    print(f"[scroll] final produtos={final_count}")
    return final_count


async def extrair_catalogo(page) -> dict[str, set[str]]:
    cards = page.locator(CARD_SELECTOR)
    total = await cards.count()
    print(f"[extracao] coletando {total} cards")

    catalogo: dict[str, set[str]] = {}

    for index in range(total):
        card = cards.nth(index)
        try:
            nome_bruto = await card.locator(NAME_SELECTOR).first.text_content(timeout=5000)
        except PlaywrightTimeoutError:
            continue

        nome = normalize_text(nome_bruto)
        if not nome:
            continue

        color_locator = card.locator(COLOR_SELECTOR)
        color_count = await color_locator.count()
        cores: set[str] = set()

        for color_index in range(color_count):
            aria_label = await color_locator.nth(color_index).get_attribute("aria-label")
            cor = normalize_text(aria_label)
            if cor:
                cores.add(cor)

        catalogo.setdefault(nome, set()).update(cores)

    print(f"[extracao] produtos unicos={len(catalogo)}")
    return catalogo


def montar_resultados(
    itens_excel: Iterable[ItemConsulta],
    catalogo: dict[str, set[str]],
) -> list[dict[str, str]]:
    rows: list[dict[str, str]] = []

    for item in itens_excel:
        cores_site = catalogo.get(item.nome)
        if cores_site is None:
            status = "PRODUTO_NAO_ENCONTRADO"
            cores_encontradas = ""
        elif item.cor in cores_site:
            status = "DISPONIVEL"
            cores_encontradas = ", ".join(sorted(cores_site))
        else:
            status = "COR_NAO_ENCONTRADA"
            cores_encontradas = ", ".join(sorted(cores_site))

        rows.append(
            {
                "item_original": item.item_original,
                "nome": item.nome,
                "cor": item.cor,
                "status": status,
                "cores_encontradas_no_site": cores_encontradas,
            }
        )

    return rows


def salvar_csv(rows: list[dict[str, str]]) -> None:
    with CSV_PATH.open("w", newline="", encoding="utf-8-sig") as csv_file:
        writer = csv.DictWriter(
            csv_file,
            fieldnames=[
                "item_original",
                "nome",
                "cor",
                "status",
                "cores_encontradas_no_site",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)


async def main() -> int:
    inicio = time.time()
    itens_excel = carregar_itens_excel()
    print(f"[excel] itens carregados={len(itens_excel)}")

    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp("http://localhost:9222")
        page = await encontrar_pagina_catalogo(browser)
        print(f"[chrome] pagina encontrada={page.url}")
        await esperar_cards_iniciais(page)
        await scroll_ate_fim(page)
        catalogo = await extrair_catalogo(page)
        await browser.close()

    rows = montar_resultados(itens_excel, catalogo)
    salvar_csv(rows)

    disponiveis = sum(1 for row in rows if row["status"] == "DISPONIVEL")
    cor_nao_encontrada = sum(
        1 for row in rows if row["status"] == "COR_NAO_ENCONTRADA"
    )
    produto_nao_encontrado = sum(
        1 for row in rows if row["status"] == "PRODUTO_NAO_ENCONTRADO"
    )
    duracao = time.time() - inicio

    print(
        "[resultado] "
        f"csv={CSV_PATH} "
        f"disponivel={disponiveis} "
        f"cor_nao_encontrada={cor_nao_encontrada} "
        f"produto_nao_encontrado={produto_nao_encontrado} "
        f"duracao_s={duracao:.1f}"
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(asyncio.run(main()))
    except Exception as exc:  # pragma: no cover
        print(f"[erro] {exc}", file=sys.stderr)
        raise

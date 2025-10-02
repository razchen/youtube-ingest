#!/usr/bin/env python3
import argparse
import csv
import json
from collections import defaultdict
from urllib.parse import urlparse

def extract_category_country(start_url: str):
    """
    Example: https://socialblade.com/youtube/lists/top/100/subscribers/travel/US
    -> category='travel', country='US'
    """
    path = urlparse(start_url).path.strip("/")
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return None, None
    # Typically last two segments are category and country
    country = parts[-1]
    category = parts[-2]
    return category, country

def extract_handle(link_href: str):
    """
    Example: https://socialblade.com/youtube/handle/nasdaily
    -> 'nasdaily'
    """
    path = urlparse(link_href).path.strip("/")
    parts = [p for p in path.split("/") if p]
    if not parts:
        return None
    return parts[-1]

def main():
    ap = argparse.ArgumentParser(description="Extract country, category, and handle from SocialBlade CSV.")
    ap.add_argument("csv_path", help="Path to the CSV file exported from your scraper")
    ap.add_argument("--start-url-col", default="web-scraper-start-url", help="Column name for the start URL")
    ap.add_argument("--href-col", default="Link-href", help="Column name for the channel link href")
    ap.add_argument("--pretty", action="store_true", help="Pretty-print JSON output")
    args = ap.parse_args()

    # Aggregate by (handle, country) so categories can be merged
    buckets = defaultdict(set)  # key=(handle,country) -> set(categories)

    with open(args.csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            start_url = (row.get(args.start_url_col) or "").strip()
            link_href = (row.get(args.href_col) or "").strip()

            category, country = extract_category_country(start_url)
            handle = extract_handle(link_href)

            if not handle or not country or not category:
                # Skip malformed rows gracefully
                continue

            buckets[(handle, country)].add(category)

    # Build output
    result = []
    for (handle, country), categories in buckets.items():
        result.append({
            "country": country,
            "handle": handle,
            "categories": sorted(categories)
        })

    print(json.dumps(result, indent=2 if args.pretty else None, ensure_ascii=False))

if __name__ == "__main__":
    main()

"""Real-estate listings over the RESO Web API.

This is the Zillow answer, and it needs stating plainly: Zillow retired its
public listings API in 2021, and its terms and robots.txt both prohibit
scraping listing pages. There is no honest way for an app to pull live Zillow
listings without a licence.

What does exist is the RESO Web API, the industry-standard feed your MLS or
Bridge Interactive (a Zillow Group company) provides to licensed brokers,
agents and their vendors. If you have that access, paste the endpoint and token
and Forge reads listings and photos from it. If you do not, the honest options
are a licensed data vendor, or importing a listing you have the rights to by
hand.
"""

from __future__ import annotations

import urllib.parse

from .base import Connector, CredentialField, Reference
from .net import NetworkGate, build_query


class ResoConnector(Connector):
    id = "reso"
    label = "Real estate (RESO / Bridge)"
    description = (
        "Live MLS listings and photos through the RESO Web API, using the "
        "endpoint and token your MLS or Bridge Interactive issued you."
    )
    domains = ()
    docs_url = "https://bridgedataoutput.com/docs/platform/"
    note = (
        "Zillow has no public listings API and prohibits scraping, so this is "
        "the licensed route: your own MLS or Bridge Interactive feed."
    )
    credential_fields = (
        CredentialField("endpoint", "RESO endpoint", secret=False, required=True,
                        placeholder="https://api.bridgedataoutput.com/api/v2/OData/<dataset>"),
        CredentialField("access_token", "Access token", secret=True, required=True),
    )

    def extra_domains(self, credentials: dict[str, str]) -> tuple[str, ...]:
        endpoint = (credentials.get("endpoint") or "").strip()
        if not endpoint:
            return ()
        host = urllib.parse.urlsplit(endpoint).netloc.split(":")[0].lower()
        return (host,) if host else ()

    def search(self, query, gate: NetworkGate, credentials, limit: int = 12):
        endpoint = (credentials.get("endpoint") or "").strip().rstrip("/")
        if "://" not in endpoint:
            raise RuntimeError(
                "Set the RESO endpoint to the full URL your MLS issued, "
                "starting with https://"
            )

        params = {
            "$top": max(1, min(limit, 50)),
            "$orderby": "ModificationTimestamp desc",
            "access_token": credentials.get("access_token", ""),
        }
        # OData string literals escape a single quote by doubling it.
        term = (query or "").strip().replace("'", "''")
        if term:
            params["$filter"] = (
                f"contains(UnparsedAddress,'{term}') or contains(City,'{term}')"
            )

        payload = gate.json(
            build_query(f"{endpoint}/Property", params), connector=self.id
        )

        results: list[Reference] = []
        for item in payload.get("value", []):
            media = sorted(
                [m for m in (item.get("Media") or []) if m.get("MediaURL")],
                key=lambda m: m.get("Order", 0),
            )
            photo = media[0]["MediaURL"] if media else ""
            address = item.get("UnparsedAddress") or ""
            city = item.get("City") or ""
            price = item.get("ListPrice")
            headline = ", ".join(part for part in (address, city) if part) or "Listing"
            facts = [
                f"{item['BedroomsTotal']} bd" if item.get("BedroomsTotal") else "",
                f"{item['BathroomsTotalInteger']} ba" if item.get("BathroomsTotalInteger") else "",
                f"{item['LivingArea']} sqft" if item.get("LivingArea") else "",
                f"${price:,}" if isinstance(price, (int, float)) else "",
            ]
            results.append(Reference(
                id=f"reso:{item.get('ListingKey', '')}",
                source=self.id,
                title=headline,
                summary=self._clean(item.get("PublicRemarks"), 800),
                page_url=item.get("ListingURL", "") or "",
                image_url=photo,
                thumb_url=photo,
                license="MLS listing data; use per your licence agreement",
                author=item.get("ListOfficeName", "") or "",
                tags=[fact for fact in facts if fact],
                extra={
                    "city": city,
                    "state": item.get("StateOrProvince", ""),
                    "price": price,
                    "photos": len(media),
                },
            ))
        return results

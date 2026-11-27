---
name: shopping-research
description: "Find where to buy something, compare prices, check if a shop ships to a country, estimate the delivered total, or pick a product for a budget. Use for Azerbaijani (harada alım, qiymət, ucuz, çatdırılma, Bakıya göndərir, büdcə), Russian (где купить, цена, дешевле, доставка, бюджет), Turkish (nereden alırım, fiyat, kargo), Arabic (أين أشتري، السعر، أرخص، الشحن), Chinese (哪里买, 价格, 二手) and English (where to buy, cheaper, ships to, budget) requests, and for any product or part link the owner sends."
---

# Shopping research

Answer in this chat (a few page reads). Use a background task (skill `background-tasks`) only when the owner asks for a file or the research
clearly needs more than about 20 web steps.

## 1. The page they sent

If the owner sent a shop link, open it first and read the price, stock and seller. Then open that shop's shipping
or international delivery page and answer "Does it ship to <country>?" with a plain yes or no, quoting or closely
paraphrasing the policy sentence and linking the policy page. "I could not confirm" is allowed only when the shop
has no policy page you could read; say which page you tried.

## 2. What exactly to buy

- Car parts: confirm fitment from the maker's catalogue or the VIN (engine, years, superseded numbers). Name the part
  numbers for the other engine or trim when they differ, instead of only asking which one they have.
- Other products: lead with the option whose key specs you verified on a maker or shop page. Separate real specs
  from marketing (mechanical gimbal vs electronic stabilisation, native vs interpolated 4K, real capacity).

## 3. Two or three real options

- Search the big marketplaces for the exact model or part number: eBay, Amazon, AliExpress, RockAuto for car parts,
  and the owner's own country (Azerbaijan: Tap.az, Umico; Russia: Avito, Ozon, Wildberries; Turkey: Trendyol,
  Hepsiburada, Sahibinden; Gulf: Amazon.ae or .sa, Noon).
- China, or a budget in yuan: name Taobao 淘宝, JD 京东 and Xianyu 闲鱼 (used), with Chinese search terms the owner
  can paste, for example `大疆 Pocket 2 二手` or `运动相机 4K 防抖`.
- Budget below the new price: check used first and say plainly what the budget buys new and what it buys used.
- Only list an option you opened. Each option gives price, condition (new or used), seller or shop, and its own
  link to the exact listing or product page you read.

## 4. Delivered total

When the item must travel to the owner's country, open one real forwarder or carrier rate page (for Azerbaijan
from the US, for example a US address forwarder with a published per-kg tariff) and give, per option: item price
+ shipping inside the origin country + forwarder rate for an assumed packed weight + customs when it applies =
estimated total. Say the weight assumption in one line. Unknown parts make the total conditional ("about $40 plus
eBay shipping, usually $0 to $10"), never "final price unknown".

## 5. Before you send: check every line

Go through the draft and fix it before sending:

1. Every option line ends with a plain https link to the page you read. An option without a link is removed or its
   page is opened now. Remove tracking parameters such as `utm_source`.
2. The "ships to" question from step 1 is answered yes or no with the policy link.
3. China or yuan budgets: Taobao, JD and Xianyu are named with Chinese search terms.
4. Each option has an estimated delivered total when shipping matters, with the rate page linked.
5. The date of the check is stated once ("checked 1 Nov").

Keep it short for a phone: one line per option, numbered, link at the end of the line.

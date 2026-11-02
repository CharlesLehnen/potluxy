# Submitting Your Sitemap to Google Search Console

## Step 1: Open Google Search Console

Go to https://search.google.com/search-console and sign in with the Google account that owns potluxy.com.

## Step 2: Add Your Property (if not already added)

If www.potluxy.com isn't already a property:

1. Click **Add property** (top-left dropdown)
2. Choose **URL prefix** and enter `https://www.potluxy.com`
3. Verify ownership — since you use GitHub Pages, the easiest methods are:
   - **HTML file upload**: Download the verification file, add it to the repo root, commit and push
   - **HTML tag**: Add the `<meta>` tag Google gives you into `<head>` of `index.html`
   - **Google Analytics**: Already set up on the site (gtag G-85WKC57ZDT), so this may auto-verify

## Step 3: Submit the Sitemap

1. In the left sidebar, click **Sitemaps**
2. In the "Add a new sitemap" field, enter: `sitemap.xml`
3. Click **Submit**

Google will show the status as "Pending" initially. It typically processes within a few hours to a few days.

## Step 4: Verify It Worked

After processing, the Sitemaps page will show:
- **Status**: "Success"
- **Discovered URLs**: 4 (index, privacy, terms, contact)

## Step 5: Request Indexing for Key Pages (Optional, Speeds Things Up)

1. In the left sidebar, click **URL Inspection**
2. Paste `https://www.potluxy.com/` in the top search bar
3. Click **Request Indexing**
4. Repeat for any other pages you want indexed quickly

## Notes

- The sitemap at `/sitemap.xml` is also referenced in `/robots.txt`, so crawlers will find it automatically over time even without manual submission
- Google Search Console also shows you search queries, click-through rates, and indexing issues — worth checking weekly leading up to Thanksgiving

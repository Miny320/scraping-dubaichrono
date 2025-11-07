const fs = require('fs');
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config.json');

const CONFIG = {
    PARENT_URL: config.PARENT_URL,
    CHECK_INTERVAL: config.CHECK_INTERVAL || 86400000, // Default: 24 hours
    BACK_END_URL: config.BACK_END_URL
};

// HTTP request configuration
const axiosConfig = {
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Ch-Ua': '"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Referer': 'https://dubaichrono.com/',
    },
    timeout: 120000,
    maxRedirects: 5,
    decompress: true, // Automatically decompress gzip/deflate/br
};

// Helper function to make HTTP request and parse HTML
const fetchHTML = async (url, retries = 2) => {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await axios.get(url, axiosConfig);
            
            // Check if response is HTML
            if (response.headers['content-type'] && !response.headers['content-type'].includes('text/html')) {
                throw new Error(`Unexpected content type: ${response.headers['content-type']}`);
            }
            
            // Check for Cloudflare challenge
            if (response.data.includes('Just a moment') || response.data.includes('cf-browser-verification')) {
                console.log('  Cloudflare challenge detected, waiting...');
                await new Promise(r => setTimeout(r, 10000));
                if (attempt < retries) continue;
            }
            
            return cheerio.load(response.data);
        } catch (e) {
            console.log(`  Attempt ${attempt} failed:`, e.message);
            if (attempt === retries) throw e;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
};

// Step 1: Get brand page URLs from https://dubaichrono.com/brands/
const getBrandPageUrls = async () => {
    try {
        const brandsUrl = 'https://dubaichrono.com/brands/';
        console.log(`Fetching brands from: ${brandsUrl}`);
        
        // Fetch the brands page
        const $ = await fetchHTML(brandsUrl, 2);
        
        const brandPages = [];
        const seenUrls = new Set();
        
        // Extract brand URLs only from div elements with class "logo-grid-item elementor-animation-bob"
        $('.logo-grid-item.elementor-animation-bob').each((index, item) => {
            const $item = $(item);
            const link = $item.find('a').first();
            
            if (link.length > 0) {
                let url = link.attr('href');
                
                if (url) {
                    // Normalize URL to full URL
                    url = url.startsWith('http') ? url : new URL(url, brandsUrl).href;
                    const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '') + '/';
                    
                    if (!seenUrls.has(normalizedUrl)) {
                        seenUrls.add(normalizedUrl);
                        
                        // Extract brand name from link text or image alt text
                        let brandName = link.text().trim();
                        
                        // Try to get brand name from image alt text if link text is empty
                        if (!brandName) {
                            const img = $item.find('img').first();
                            brandName = img.attr('alt') || img.attr('title') || '';
                        }
                        
                        // Fallback to extracting from URL
                        if (!brandName) {
                            const urlObj = new URL(normalizedUrl);
                            const pathParts = urlObj.pathname.split('/').filter(Boolean);
                            if (pathParts.length > 0) {
                                brandName = pathParts[pathParts.length - 1]
                                    .replace(/-/g, ' ')
                                    .replace(/\b\w/g, l => l.toUpperCase());
                            }
                        }
                        
                        brandPages.push({
                            url: normalizedUrl,
                            brandName: brandName || normalizedUrl
                        });
                    }
                }
            }
        });
        
        console.log(`Found ${brandPages.length} brand pages from ${brandsUrl}`);
        return brandPages;
    } catch (e) {
        console.error('Error getting brand page URLs:', e.message);
        return [];
    }
};

// Step 2: Get collection URLs from a brand page (e.g., /audemars-piguet/ → /collections/royal-oak-by-audemars-piguet/)
const getCollectionUrlsFromBrandPage = async (brandPageUrl) => {
    try {
        const $ = await fetchHTML(brandPageUrl, 2);
        
        const collectionUrls = [];
        const seenUrls = new Set();
        
        // Priority 1: Extract from "View Collection" buttons (ue-btn-wrapper, ue-btn, uc-link)
        const ueBtnWrappers = $('.ue-btn-wrapper');
        
        ueBtnWrappers.each((index, container) => {
            const $container = $(container);
            // Find any <a> tag inside ue-btn-wrapper that has href containing /collections/
            const link = $container.find('a[href*="/collections/"]').first();
            
            if (link.length > 0) {
                // Get the href attribute
                let url = link.attr('href');
                
                if (url && url.includes('/collections/')) {
                    // Normalize URL to full URL
                    url = url.startsWith('http') ? url : new URL(url, brandPageUrl).href;
                    const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '') + '/';
                    
                    if (!seenUrls.has(normalizedUrl)) {
                        seenUrls.add(normalizedUrl);
                        
                        // Try multiple methods to extract collection name
                        let collectionName = '';
                        
                        // Method 1: Look for heading/title in parent container or previous siblings
                        const $parent = $container.parent();
                        // Check for headings before or after the container
                        collectionName = $container.prev('h1, h2, h3, h4, h5, h6, .title, .heading').first().text().trim() ||
                            $container.siblings('h1, h2, h3, h4, h5, h6, .title, .heading').first().text().trim() ||
                            $parent.find('h1, h2, h3, h4, h5, h6, .title, .heading').first().text().trim();
                        
                        // Method 2: Look in nearby card/item/section containers (walk up the DOM tree)
                        if (!collectionName) {
                            const $section = $container.closest('section, [class*="card"], [class*="item"], [class*="product"], [class*="collection"], [class*="wrapper"]');
                            collectionName = $section.find('h1, h2, h3, h4, h5, h6, .title, .heading').first().text().trim();
                        }
                        
                        // Method 3: Look for text in previous elements (often collection names come before buttons)
                        if (!collectionName) {
                            const $prevElements = $container.prevAll('h1, h2, h3, h4, h5, h6, p, div[class*="title"], div[class*="heading"]').first();
                            collectionName = $prevElements.text().trim();
                        }
                        
                        // Method 4: Extract from URL slug as fallback
                        if (!collectionName || collectionName.length < 3) {
                            const urlSlug = normalizedUrl.split('/collections/')[1]?.replace(/\//g, '') || '';
                            collectionName = urlSlug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                        }
                        
                        collectionUrls.push({
                            url: normalizedUrl,
                            collectionName: collectionName
                        });
                    }
                }
            }
        });
        
        // Also check direct .ue-btn links
        $('a.ue-btn[href*="/collections/"]').each((index, el) => {
            const $el = $(el);
            let url = $el.attr('href');
            
            if (url && url.includes('/collections/')) {
                url = url.startsWith('http') ? url : new URL(url, brandPageUrl).href;
                const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '') + '/';
                
                if (!seenUrls.has(normalizedUrl)) {
                    seenUrls.add(normalizedUrl);
                    const linkText = $el.text().trim() || $el.find('.uc-link').text().trim();
                    const collectionName = linkText || normalizedUrl.split('/collections/')[1]?.replace(/\//g, '').replace(/-/g, ' ') || '';
                    
                    collectionUrls.push({
                        url: normalizedUrl,
                        collectionName: collectionName
                    });
                }
            }
        });
        
        // Priority 2: Look for collection links on the brand page (general)
        $('a[href*="/collections/"]').each((index, el) => {
            const $el = $(el);
            let url = $el.attr('href');
            
            if (url && url.includes('/collections/')) {
                url = url.startsWith('http') ? url : new URL(url, brandPageUrl).href;
                const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '') + '/';
                
                if (!seenUrls.has(normalizedUrl)) {
                    seenUrls.add(normalizedUrl);
                    const collectionName = $el.text().trim() || normalizedUrl.split('/collections/')[1]?.replace(/\//g, '').replace(/-/g, ' ') || '';
                    collectionUrls.push({
                        url: normalizedUrl,
                        collectionName: collectionName
                    });
                }
            }
        });
        
        // Priority 3: Try finding collection links in specific containers
        $('.elementor-image-box-wrapper, .collection-item, .product-category').each((index, container) => {
            const $container = $(container);
            const link = $container.find('a[href*="/collections/"]').first();
            
            if (link.length > 0) {
                let url = link.attr('href');
                if (url) {
                    url = url.startsWith('http') ? url : new URL(url, brandPageUrl).href;
                    const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '') + '/';
                    
                    if (!seenUrls.has(normalizedUrl)) {
                        seenUrls.add(normalizedUrl);
                        const collectionName = link.text().trim() || $container.find('h2, h3, .title').text().trim() || '';
                        collectionUrls.push({
                            url: normalizedUrl,
                            collectionName: collectionName
                        });
                    }
                }
            }
        });
        
        console.log(`  Found ${collectionUrls.length} collections from brand page`);
        
        // If no collections found, the brand page itself contains products directly
        if (collectionUrls.length === 0) {
            console.log(`  No collections found - products are listed directly on brand page`);
            // Return the brand page as a "collection" to scrape products from
            return [{
                url: brandPageUrl,
                collectionName: 'All Products'
            }];
        }
        
        return collectionUrls;
    } catch (e) {
        console.error(`  Error getting collections from ${brandPageUrl}:`, e.message);
    return [];
    }
};

// Loop 2: Scrape all pages of a collection (with pagination)
const scrapeCollectionPages = async (collectionUrl) => {
    const allWatchLinks = [];
    const seenUrls = new Set(); // For deduplication within collection
        let currentUrl = collectionUrl;
        let hasNextPage = true;
        let pageNum = 1;
        
    try {
        while (hasNextPage && pageNum <= 50) { // Safety limit
            console.log(`  Scraping collection page ${pageNum}: ${currentUrl}`);
            
            const $ = await fetchHTML(currentUrl, 2);
            
            // Extract watch links from this page
            const pageLinks = [];
            
            // Primary selector: WooCommerce product list items
            $('ul.products li.product, li.product.type-product, .products li.product').each((index, li) => {
                const $li = $(li);
                const linkEl = $li.find('a.woocommerce-LoopProduct-link, a[href*="/watches/"], a.woocommerce-loop-product__link, h2.woocommerce-loop-product__title a, h3 a').first();
                
                if (linkEl.length > 0) {
                    let url = linkEl.attr('href');
                    if (url) {
                        // Ensure full URL
                        url = url.startsWith('http') ? url : new URL(url, collectionUrl).href;
                        
                        // Normalize URL for deduplication
                        const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '');
                        
                        if (!seenUrls.has(normalizedUrl)) {
                            seenUrls.add(normalizedUrl);
                            pageLinks.push(normalizedUrl);
                        }
                    }
                }
            });
            
            // Priority 1: Extract from specific grid containers (for Cartier and similar pages)
            // These containers contain the main product grid
            $('.uc_post_grid_style_one_item, .ue-item, .uc_post_grid_style_one_item .ue-item').each((index, item) => {
                const $item = $(item);
                // Try to find product link in image or title
                const link = $item.find('a[href*="/watches/"], a[href*="/product/"], .uc_post_grid_style_one_image, .uc_title a').first();
                
                if (link.length > 0) {
                    let url = link.attr('href');
                    if (!url) return;
                    
                    // Skip invalid URLs
                    if (url.includes('#') || 
                        url.includes('javascript:') || 
                        /\/cart(\/|\?|$)/.test(url) ||  // Match /cart/, /cart?, or /cart at end, but not /cartier
                        url.includes('/checkout') ||
                        url.includes('/account') ||
                        url.includes('/shop/') ||
                        url.includes('/category/')) {
                        return;
                    }
                    
                    // Normalize URL
                    url = url.startsWith('http') ? url : new URL(url, collectionUrl).href;
                    const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '');
                    
                    // Only add if it's a valid product URL
                    if ((normalizedUrl.includes('/watches/') || normalizedUrl.includes('/product/')) &&
                        normalizedUrl.length > 30) {
                        if (!seenUrls.has(normalizedUrl)) {
                            seenUrls.add(normalizedUrl);
                            pageLinks.push(normalizedUrl);
                        }
                    }
                }
            });
            
            // Priority 2: Extract from WooCommerce product containers
            $('.product, .woocommerce-loop-product, [class*="product"]').each((index, product) => {
                const $product = $(product);
                const link = $product.find('a[href*="/watches/"], a[href*="/product/"]').first();
                if (link.length > 0) {
                    let url = link.attr('href');
                    if (!url) return;
                    
                    // Skip invalid URLs
                    if (url.includes('#') || 
                        url.includes('javascript:') || 
                        /\/cart(\/|\?|$)/.test(url) ||  // Match /cart/, /cart?, or /cart at end, but not /cartier
                        url.includes('/checkout') ||
                        url.includes('/account') ||
                        url.includes('/shop/') ||
                        url.includes('/category/')) {
                        return;
                    }
                    
                    url = url.startsWith('http') ? url : new URL(url, collectionUrl).href;
                    const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '');
                    
                    if (!seenUrls.has(normalizedUrl) && 
                        (normalizedUrl.includes('/watches/') || normalizedUrl.includes('/product/'))) {
                        seenUrls.add(normalizedUrl);
                        pageLinks.push(normalizedUrl);
                    }
                }
            });
            
            // Priority 3: Fallback to general selectors (for other page structures)
            // Only use this if we haven't found many products yet
            if (pageLinks.length < 10) {
                const allProductLinks = $('a[href*="/watches/"], a[href*="/product/"]');
                
                allProductLinks.each((index, el) => {
                    const $el = $(el);
                    let url = $el.attr('href');
                    
                    if (!url) return;
                    
                    // Skip invalid URLs
                    if (url.includes('#') || 
                        url.includes('javascript:') || 
                        /\/cart(\/|\?|$)/.test(url) ||  // Match /cart/, /cart?, or /cart at end, but not /cartier
                        url.includes('/checkout') ||
                        url.includes('/account') ||
                        url.includes('/shop/') ||
                        url.includes('/category/')) {
                        return;
                    }
                    
                    // Normalize URL
                    url = url.startsWith('http') ? url : new URL(url, collectionUrl).href;
                    const normalizedUrl = url.split('#')[0].split('?')[0].replace(/\/$/, '');
                    
                    // Only add if it's a valid product URL and has reasonable length
                    if ((normalizedUrl.includes('/watches/') || normalizedUrl.includes('/product/')) &&
                        normalizedUrl.length > 30) {
                        if (!seenUrls.has(normalizedUrl)) {
                            seenUrls.add(normalizedUrl);
                            pageLinks.push(normalizedUrl);
                        }
                    }
                });
            }
            
            if (pageLinks.length === 0) {
                console.log('    No products found with any selector on this page.');
            }
            
            allWatchLinks.push(...pageLinks);
            console.log(`    Found ${pageLinks.length} watches on page ${pageNum} (total so far: ${allWatchLinks.length})`);
            
            // Check for next page - try multiple pagination patterns
            let nextUrl = null;
            let maxPageNum = pageNum;
            
            // First, check for querydata attribute in grid containers (for AJAX pagination)
            // This often contains total_posts, num_pages, etc.
            $('.uc_post_grid_style_one, .uc-filterable-grid, [querydata]').each((i, el) => {
                const $el = $(el);
                const queryDataAttr = $el.attr('querydata');
                if (queryDataAttr) {
                    try {
                        const queryData = JSON.parse(queryDataAttr.replace(/&quot;/g, '"'));
                        if (queryData.num_pages && queryData.num_pages > maxPageNum) {
                            maxPageNum = queryData.num_pages;
                            console.log(`    Found num_pages in querydata: ${maxPageNum} (total_posts: ${queryData.total_posts || 'N/A'})`);
                        }
                    } catch (e) {
                        // Ignore parse errors
                    }
                }
            });
            
            // Then, check if pagination exists and find max page number
            // Look for page numbers (even if they're not links - just text or spans)
            // Handle both cases: single containers with multiple numbers, and individual containers per number
            $('.page-numbers, .woocommerce-pagination, .pagination, [class*="pagination"]').each((i, el) => {
                const $el = $(el);
                const text = $el.text().trim();
                
                // Check if this element itself is a page number (single digit)
                if (/^\d+$/.test(text)) {
                    const num = parseInt(text);
                    if (num > maxPageNum && num <= 100) {
                        maxPageNum = num;
                    }
                }
                
                // Also check child elements (spans, divs with page numbers)
                $el.find('span, div, a, li').each((j, child) => {
                    const childText = $(child).text().trim();
                    // Check if child is a single page number
                    if (/^\d+$/.test(childText)) {
                        const num = parseInt(childText);
                        if (num > maxPageNum && num <= 100) {
                            maxPageNum = num;
                        }
                    }
                    // Also extract multiple numbers from text (e.g., "1 2 3 4 5 6 7 8")
                    const pageNums = childText.match(/\b\d+\b/g);
                    if (pageNums) {
                        pageNums.forEach(numStr => {
                            const num = parseInt(numStr);
                            if (num > maxPageNum && num <= 100) {
                                maxPageNum = num;
                            }
                        });
                    }
                });
                
                // Also check the element's own text for multiple numbers
                const pageNums = text.match(/\b\d+\b/g);
                if (pageNums) {
                    pageNums.forEach(numStr => {
                        const num = parseInt(numStr);
                        if (num > maxPageNum && num <= 100) {
                            maxPageNum = num;
                        }
                    });
                }
            });
            
            if (maxPageNum > pageNum) {
                console.log(`    Detected pagination: pages 1-${maxPageNum}`);
            }
            
            // Try WooCommerce pagination - look for clickable next button or links
            const nextBtn = $('.woocommerce-pagination .page-numbers.next, .page-numbers.next, a.next, .next a');
            if (nextBtn.length > 0 && !nextBtn.hasClass('disabled')) {
                nextUrl = nextBtn.attr('href');
            }
            
            // Try general pagination links
            if (!nextUrl) {
                const currentPageNum = pageNum;
                $('.page-numbers a, .woocommerce-pagination a, .pagination a, a.page-numbers').each((i, el) => {
                    const $el = $(el);
                    const text = $el.text().trim().toLowerCase();
                    const href = $el.attr('href');
                    
                    if (!href) return;
                    
                    // Check if this is a "next" link or a page number greater than current
                    if (text.includes('next') || text.includes('>') || text === '→') {
                        nextUrl = href;
                        return false; // break
                    } else if (/^\d+$/.test(text)) {
                        const pageNumText = parseInt(text);
                        if (pageNumText === currentPageNum + 1) {
                            nextUrl = href;
                            return false; // break
                        }
                    }
                });
            }
            
            // If no clickable next link found, but we detected page numbers, construct next page URL
            if (!nextUrl && maxPageNum > pageNum) {
                const baseUrl = collectionUrl.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '');
                const nextPageNum = pageNum + 1;
                nextUrl = baseUrl + '/page/' + nextPageNum + '/';
                console.log(`    Detected page numbers up to ${maxPageNum}, constructing page ${nextPageNum} URL: ${nextUrl}`);
            }
            
            // If no pagination detected but we found products on first page, try page 2 anyway
            if (!nextUrl && pageLinks.length > 0 && pageNum === 1) {
                const baseUrl = collectionUrl.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '');
                const page2Url = baseUrl + '/page/2/';
                nextUrl = page2Url;
                console.log(`    Will try page 2 to check for more products: ${nextUrl}`);
            }
            
            hasNextPage = !!nextUrl;
            
            if (hasNextPage && nextUrl) {
                nextUrl = nextUrl.startsWith('http') ? nextUrl : new URL(nextUrl, collectionUrl).href;
                const normalizedNextUrl = nextUrl.split('#')[0].split('?')[0].replace(/\/$/, '') + '/';
                const normalizedCurrentUrl = currentUrl.split('#')[0].split('?')[0].replace(/\/$/, '') + '/';
                
                // Only proceed if URLs are different
                if (normalizedNextUrl !== normalizedCurrentUrl) {
                    // Check if we've exceeded max page number (if detected from pagination)
                    const nextPageNum = pageNum + 1;
                    if (maxPageNum > 0 && nextPageNum > maxPageNum) {
                        hasNextPage = false;
                        console.log(`    Reached max page ${maxPageNum}, stopping`);
                    } else {
                        currentUrl = normalizedNextUrl;
                        pageNum = nextPageNum;
                        await new Promise(r => setTimeout(r, 1500)); // Delay between pages
                    }
                } else {
                    hasNextPage = false;
                }
                } else {
                    hasNextPage = false;
            }
            
            // Stop if we found no products on current page and no next page
            // BUT only stop if we've already tried at least 2 pages or reached max page
            if (pageLinks.length === 0 && !hasNextPage) {
                if (pageNum >= 2 || (maxPageNum > 0 && pageNum >= maxPageNum)) {
                    console.log(`    No products found on page ${pageNum} and no next page - stopping`);
                } else {
                    // Try next page anyway if we haven't reached detected max
                    if (maxPageNum > 0 && pageNum < maxPageNum) {
                        const baseUrl = collectionUrl.replace(/\/page\/\d+\/?$/, '').replace(/\/$/, '');
                        nextUrl = baseUrl + '/page/' + (pageNum + 1) + '/';
                        hasNextPage = true;
                        console.log(`    No products on page ${pageNum}, but continuing to page ${pageNum + 1}`);
                    }
                }
            }
            
            // Delay between requests
            await new Promise(r => setTimeout(r, 1000));
        }
        
        console.log(`  Total watches found in collection: ${allWatchLinks.length}`);
        
        // Log summary
        const uniqueCount = new Set(allWatchLinks).size;
        if (uniqueCount !== allWatchLinks.length) {
            console.log(`  Note: ${allWatchLinks.length - uniqueCount} duplicate URLs were filtered`);
        }
        console.log(`  Unique product URLs: ${uniqueCount}`);
        
        return allWatchLinks;
    } catch (e) {
        console.log('Collection pages error:', e.message);
        return allWatchLinks;
    }
};

// Extract product data from a single product page
const extractProductDataFromPage = async (productUrl, index, brandName = null, collectionName = null) => {
    try {
        const $ = await fetchHTML(productUrl, 2);
        
        // Extract brand - use provided brandName or try to extract from page
        let brand = brandName || null;
        if (!brand) {
            // Try to extract from breadcrumbs, title, or meta tags
            const breadcrumbs = $('.breadcrumb, [class*="breadcrumb"]').text();
            const title = $('h1').first().text().trim();
            // Try structured data
            const scriptTags = $('script[type="application/ld+json"]');
            for (let i = 0; i < scriptTags.length; i++) {
                try {
                    const jsonData = JSON.parse($(scriptTags[i]).html());
                    if (jsonData.brand && jsonData.brand.name) {
                        brand = jsonData.brand.name;
                        break;
                    }
                } catch (e) {}
            }
        }
        
        // Extract model - from title
        let model = null;
        const title = $('h1').first().text().trim();
        if (title) {
            // Remove "Reference" part and clean up
            model = title.replace(/\s*Reference\s+\d+.*$/i, '').trim();
            if (brand && model.toLowerCase().includes(brand.toLowerCase())) {
                model = model.replace(new RegExp(brand, 'gi'), '').trim();
            }
        }
        
        // Extract reference number
        let referenceNumber = null;
        // Try to find "Reference" in title
        const refMatch = title.match(/Reference\s+([A-Z0-9\.\-]+)/i);
        if (refMatch && refMatch[1]) {
            referenceNumber = refMatch[1].trim();
        }
        // Try to find in product details
        if (!referenceNumber) {
            const bodyText = $('body').text();
            const refPatterns = [
                /(?:reference|ref\.?|model)\s*(?:number|no\.?|#)?\s*[:\-]?\s*([A-Z0-9\.\-\s]{3,20})/i,
                /ref[:\-]?\s*([A-Z0-9\.\-]+)/i
            ];
            for (const pattern of refPatterns) {
                const match = bodyText.match(pattern);
                if (match && match[1]) {
                    referenceNumber = match[1].trim();
                    break;
                }
            }
        }
        
        // Extract year
        let year = null;
        const bodyText = $('body').text();
        const yearMatch = bodyText.match(/(?:year|produced|manufactured|made)\s*[:\-]?\s*(\d{4})/i);
        if (yearMatch && yearMatch[1]) {
            const candidateYear = parseInt(yearMatch[1]);
            if (candidateYear > 1900 && candidateYear <= new Date().getFullYear() + 1) {
                year = candidateYear;
            }
        }
        
        // Extract price - prioritize product content area to avoid header/sidebar prices
        let price = null;
        let currency = 'USD';
        
        // First, identify the main product content area (exclude header, sidebar, nav, widgets)
        const excludedSelectors = 'header, .header, .sidebar, nav, .widget, .related-products, .product-grid';
        const productContentArea = $('main, .main-content, .content, article, .entry-content, .product, .woocommerce-product, [class*="product-detail"]')
            .not(excludedSelectors)
            .first();
        
        // Method 1: Search entire product content area for "Our Price" followed by price (handles multiline)
        if (productContentArea.length > 0) {
            const fullText = productContentArea.text();
            // Look for "Our Price" followed by price (handles any whitespace including newlines)
            // Use [\s\S] to match any character including newlines between "Our Price" and price
            const ourPricePattern = /Our\s+Price\s*[:]?\s*[\s\S]{0,100}?\$\s*([\d,]+\.?\d*)/i;
            const match = fullText.match(ourPricePattern);
            if (match && match[1]) {
                currency = 'USD';
                price = parseInt(match[1].replace(/,/g, ''));
            }
        }
        
        // Method 1b: Alternative - look for price in the section containing "Our Price" heading
        if (!price && productContentArea.length > 0) {
            productContentArea.find('h2, h3').each((i, el) => {
                const $el = $(el);
                const text = $el.text().trim();
                if (text.includes('Our Price')) {
                    // Get the text from the parent container that contains this h2
                    const container = $el.closest('div, section, article');
                    if (container.length > 0) {
                        const containerText = container.text();
                        // Look for price near "Our Price" (within 200 chars)
                        const priceMatch = containerText.match(/Our\s+Price\s*[:]?\s*[\s\S]{0,200}?\$\s*([\d,]+\.?\d*)/i);
                        if (priceMatch && priceMatch[1]) {
                            currency = 'USD';
                            price = parseInt(priceMatch[1].replace(/,/g, ''));
                            return false; // break
                        }
                    }
                }
            });
        }
        
        // Method 2: Look for price near the product title (H1)
        if (!price) {
            const h1 = $('h1').first();
            if (h1.length > 0) {
                // Look for price in the same section as H1
                const h1Container = h1.closest('article, .product, .woocommerce-product, main, .main-content, .content');
                if (h1Container.length > 0) {
                    // Find price that's after H1 but before other product listings
                    const priceElement = h1Container.find('.price, .woocommerce-Price-amount, [class*="price"]').first();
                    if (priceElement.length > 0) {
                        // Verify it's not from a different product (check if it's before any product grid)
                        const productGrid = priceElement.closest('.product-grid, .related-products');
                        if (productGrid.length === 0) {
                            const priceText = priceElement.text().trim();
                            // Extract currency
                            if (priceText.includes('$')) currency = 'USD';
                            else if (priceText.includes('€')) currency = 'EUR';
                            else if (priceText.includes('£')) currency = 'GBP';
                            else if (priceText.includes('AED')) currency = 'AED';
                            // Extract number
                            const priceMatch = priceText.match(/[\d,]+/);
                            if (priceMatch) {
                                price = parseInt(priceMatch[0].replace(/,/g, ''));
                            }
                        }
                    }
                }
            }
        }
        
        // Method 3: Look in product content area (exclude header, sidebar, related products)
        if (!price && productContentArea.length > 0) {
            // Find all prices in product content area
            productContentArea.find('.price, .woocommerce-Price-amount, [class*="price"]').each((i, el) => {
                const $el = $(el);
                // Skip if it's in a product card/grid (those are other products)
                const isInProductCard = $el.closest('.product, .woocommerce-loop-product, [class*="product-item"], .product-grid').length > 0;
                // Skip if it's in header/nav/sidebar
                const isInExcluded = $el.closest('header, .header, .sidebar, nav, .widget').length > 0;
                
                if (!isInProductCard && !isInExcluded) {
                    const priceText = $el.text().trim();
                    // Extract currency
                    if (priceText.includes('$')) currency = 'USD';
                    else if (priceText.includes('€')) currency = 'EUR';
                    else if (priceText.includes('£')) currency = 'GBP';
                    else if (priceText.includes('AED')) currency = 'AED';
                    // Extract number
                    const priceMatch = priceText.match(/[\d,]+/);
                    if (priceMatch) {
                        price = parseInt(priceMatch[0].replace(/,/g, ''));
                        return false; // break
                    }
                }
            });
        }
        
        // Method 4: Last resort - look for price in main content, but exclude obvious non-product areas
        if (!price) {
            $('.price, .woocommerce-Price-amount, [class*="price"]').each((i, el) => {
                const $el = $(el);
                // Skip if it's in header, sidebar, nav, or product cards (other products)
                const excludedParents = $el.closest('header, .header, .sidebar, nav, .widget, .product-grid, .related-products, .product:not(:has(h1))');
                if (excludedParents.length === 0) {
                    const priceText = $el.text().trim();
                    const priceMatch = priceText.match(/[\d,]+/);
                    if (priceMatch) {
                        if (priceText.includes('$')) currency = 'USD';
                        else if (priceText.includes('€')) currency = 'EUR';
                        else if (priceText.includes('£')) currency = 'GBP';
                        else if (priceText.includes('AED')) currency = 'AED';
                        price = parseInt(priceMatch[0].replace(/,/g, ''));
                        return false; // break
                    }
                }
            });
        }
        
        // Extract images
        const images = [];
        const seenImages = new Set();
        // Try WooCommerce product gallery
        $('.woocommerce-product-gallery img, .product-images img, [class*="product-gallery"] img').each((i, el) => {
            let imgSrc = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
            if (imgSrc) {
                imgSrc = imgSrc.split('?')[0];
                if (imgSrc && !seenImages.has(imgSrc) && imgSrc.includes('wp-content')) {
                    seenImages.add(imgSrc);
                    images.push(imgSrc);
                }
            }
        });
        // Fallback: get all images from content area
        if (images.length === 0) {
            $('img[src*="wp-content/uploads"]').each((i, el) => {
                let imgSrc = $(el).attr('src') || $(el).attr('data-src');
                if (imgSrc) {
                    imgSrc = imgSrc.split('?')[0];
                    // Filter out small thumbnails and logos
                    if (imgSrc && !seenImages.has(imgSrc) && 
                        !imgSrc.includes('logo') && 
                        !imgSrc.includes('thumbnail') &&
                        imgSrc.includes('wp-content/uploads')) {
                        seenImages.add(imgSrc);
                        images.push(imgSrc);
                    }
                }
            });
        }
        
        // Extract description for box/paper/condition
        const description = ($('.product-description, .woocommerce-product-details__short-description, [class*="description"]').text() || bodyText).toLowerCase();
        
        // Detect originalBox and originalPaper
        let originalBox = null;
        let originalPaper = null;
        
        // Check for explicit mentions
        if (description.includes('with box') || description.includes('includes box') || description.includes('original box')) {
            originalBox = true;
        } else if (description.includes('no box') || description.includes('without box') || description.includes('missing box')) {
            originalBox = false;
        }
        
        if (description.includes('with papers') || description.includes('includes papers') || description.includes('original papers') || description.includes('with documentation')) {
            originalPaper = true;
        } else if (description.includes('no papers') || description.includes('without papers') || description.includes('missing papers')) {
            originalPaper = false;
        }
        
        // Detect condition
        let condition = null;
        const conditionKeywords = [
            { key: 'unworn', value: 'unworn' },
            { key: 'like new', value: 'like new' },
            { key: 'mint condition', value: 'excellent' },
            { key: 'excellent condition', value: 'excellent' },
            { key: 'very good condition', value: 'very good' },
            { key: 'good condition', value: 'good' },
            { key: 'fair condition', value: 'fair' },
            { key: 'worn', value: 'worn' }
        ];
        for (const { key, value } of conditionKeywords) {
            if (description.includes(key)) {
                condition = value;
                break;
            }
        }
        
        // Extract location
        let location = null;
        const locationMatch = bodyText.match(/(?:location|ships from|located in|location:)\s*([A-Z][A-Za-z\s,]+)/i);
        if (locationMatch && locationMatch[1]) {
            location = locationMatch[1].trim();
        }
        // Default to Dubai if not found (based on site name)
        if (!location) {
            location = 'Dubai';
        }
        
        return {
            index: index,
            brand: brand || null,
            model: model || null,
            referenceNumber: referenceNumber || null,
            year: year || null,
            price: price || null,
            currency: currency || 'USD',
            originalBox: originalBox !== null ? originalBox : null,
            originalPaper: originalPaper !== null ? originalPaper : null,
            condition: condition || null,
            location: location || null,
            images: images.length > 0 ? images : [],
            watchUrl: productUrl
        };
    } catch (error) {
        console.error(`  ❌ Error extracting data from ${productUrl}:`, error.message);
        // Return structure with null values on error
        return {
            index: index,
            brand: brandName || null,
            model: null,
            referenceNumber: null,
            year: null,
            price: null,
            currency: 'USD',
            originalBox: null,
            originalPaper: null,
            condition: null,
            location: null,
            images: [],
            watchUrl: productUrl
        };
    }
};

// Process all product URLs and extract detailed data
const extractAllProductData = async (productUrlsData) => {
    console.log('\n=== Step 2: Extracting product data from pages ===\n');
    
    if (!productUrlsData || productUrlsData.length === 0) {
        console.error('❌ No product URLs provided!');
        return [];
    }
    
    console.log(`Found ${productUrlsData.length} product URLs to process\n`);
    
    const watchDataPath = path.join(__dirname, '..', 'watchData.json');
    let allWatchData = [];
    
    // Load existing data if file exists (for resume capability)
    try {
        if (fs.existsSync(watchDataPath)) {
            const existingData = fs.readFileSync(watchDataPath, 'utf8');
            allWatchData = JSON.parse(existingData);
            console.log(`📂 Loaded ${allWatchData.length} existing watch(es) from watchData.json`);
        }
    } catch (error) {
        console.log('⚠️  Could not load existing watchData.json, starting fresh');
        allWatchData = [];
    }
    
    // Helper function to save watch data incrementally
    const saveWatchData = () => {
        try {
            fs.writeFileSync(watchDataPath, JSON.stringify(allWatchData, null, 2));
            console.log(`💾 Saved ${allWatchData.length} watch(es) to watchData.json`);
        } catch (error) {
            console.error(`❌ Error saving watchData.json: ${error.message}`);
        }
    };
    
    const BATCH_SIZE = 50;
    const totalBatches = Math.ceil(productUrlsData.length / BATCH_SIZE);
    
    for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
        const batchStart = batchIndex * BATCH_SIZE;
        const batchEnd = Math.min(batchStart + BATCH_SIZE, productUrlsData.length);
        const batch = productUrlsData.slice(batchStart, batchEnd);
        
        console.log(`\n📦 Processing batch ${batchIndex + 1}/${totalBatches} (products ${batchStart + 1}-${batchEnd} of ${productUrlsData.length})`);
        
        // Process URLs in parallel within batch
        const batchPromises = batch.map(async (productData, idx) => {
            const globalIndex = batchStart + idx;
            const productUrl = productData.url || productData;
            const brandName = productData.brand ? productData.brand.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : null;
            
            console.log(`  [${globalIndex + 1}/${productUrlsData.length}] Extracting: ${productUrl}`);
            
            try {
                const watchData = await extractProductDataFromPage(
                    productUrl, 
                    globalIndex,
                    brandName,
                    productData.collection
                );
                return watchData;
            } catch (error) {
                console.error(`    ❌ Error processing ${productUrl}:`, error.message);
                return {
                    index: globalIndex,
                    brand: brandName || null,
                    model: null,
                    referenceNumber: null,
                    year: null,
                    price: null,
                    currency: 'USD',
                    originalBox: null,
                    originalPaper: null,
                    condition: null,
                    location: null,
                    images: [],
                    watchUrl: productUrl
                };
            }
        });
        
        // Wait for all URLs in batch to complete
        const batchResults = await Promise.all(batchPromises);
        allWatchData.push(...batchResults);
        
        // Save progress after each batch
        saveWatchData();
        
        // Delay between batches to avoid rate limiting
        if (batchIndex < totalBatches - 1) {
            await new Promise(r => setTimeout(r, 3000));
        }
    }
    
    // Sort by index to ensure correct order
    allWatchData.sort((a, b) => a.index - b.index);
    
    console.log(`\n📊 Summary:`);
    console.log(`   - Total products processed: ${allWatchData.length}`);
    console.log(`   - Products with data: ${allWatchData.filter(w => w.brand || w.model || w.price).length}`);
    
    // Save final watch data
    saveWatchData();
    console.log(`\n✅ Watch data saved to watchData.json (${allWatchData.length} items)`);
    
    return allWatchData;
};

// Step 3: Collect all product URLs (with deduplication)
const getAllProductUrls = async () => {
    console.log('\n=== Step 1: Collecting all product URLs ===\n');
    const allProductUrls = [];
    const seenProductUrls = new Set(); // For deduplication
    
    try {
        // Step 1: Get brand page URLs from homepage
        const brandPages = await getBrandPageUrls();
        console.log(`\n=== Found ${brandPages.length} brand pages ===\n`);
        
        const allCollections = [];
        
        // Step 2: Get collection URLs from each brand page (process in parallel batches)
        console.log(`\n=== Fetching collections from ${brandPages.length} brand pages ===\n`);
        
        // Process brand pages in parallel (send all requests simultaneously)
        const collectionPromises = brandPages.map(async (brandPage, index) => {
            console.log(`[${index + 1}/${brandPages.length}] Fetching collections from: ${brandPage.brandName || brandPage.url}`);
            try {
                const collections = await getCollectionUrlsFromBrandPage(brandPage.url);
                
                // Add brand info to each collection
                return collections.map(collection => ({
                    ...collection,
                    brandName: brandPage.brandName || '',
                    brandPageUrl: brandPage.url
                }));
            } catch (e) {
                console.error(`  Error processing brand ${brandPage.brandName}:`, e.message);
                return [];
            }
        });
        
        // Wait for all brand page requests to complete
        const collectionResults = await Promise.all(collectionPromises);
        
        // Flatten the results into a single array
        collectionResults.forEach(collections => {
            allCollections.push(...collections);
        });
        
        console.log(`\n=== Found ${allCollections.length} total collections ===\n`);
        
        // Step 3: Get product URLs from each collection (process in parallel)
        console.log(`\n=== Extracting products from ${allCollections.length} collections ===\n`);
        
        // Process all collections in parallel (send all requests simultaneously)
        const productPromises = allCollections.map(async (collection, index) => {
            console.log(`[${index + 1}/${allCollections.length}] Scraping products from: ${collection.collectionName || collection.url}`);
            try {
                // Get all watch links from all pages of this collection
                const watchLinks = await scrapeCollectionPages(collection.url);
                
                // Add collection/brand info to each URL
                return watchLinks.map(productUrl => {
                    // Normalize product URL for deduplication
                    const normalizedProductUrl = productUrl.split('#')[0].split('?')[0].replace(/\/$/, '');
                    
                    return {
                        url: normalizedProductUrl,
                        brand: collection.brandName || '',
                        collection: collection.collectionName || '',
                        collectionUrl: collection.url,
                        brandPageUrl: collection.brandPageUrl || ''
                    };
                });
            } catch (e) {
                console.error(`  Error scraping collection ${collection.collectionName}:`, e.message);
                return [];
            }
        });
        
        // Wait for all collection requests to complete
        const productResults = await Promise.all(productPromises);
        
        // Flatten and deduplicate product URLs
        productResults.forEach(productList => {
            productList.forEach(product => {
                if (!seenProductUrls.has(product.url)) {
                    seenProductUrls.add(product.url);
                    allProductUrls.push(product);
                }
            });
        });
        
        console.log(`\n=== Step 1 Complete: Collected ${allProductUrls.length} unique product URLs ===\n`);
        
        return allProductUrls;
    } catch (e) {
        console.error('Error collecting product URLs:', e.message);
        return allProductUrls;
    }
};

// Main scraping function: Collect URLs and extract data
const scrapeWatchData = async () => {
    try {
        // Step 1: Collect all product URLs
        const allProductUrls = await getAllProductUrls();
        
        if (allProductUrls.length === 0) {
            console.log('No product URLs found, skipping detail scraping.');
            return [];
        }
        
        // Step 2: Extract detailed data for each product
        const watchData = await extractAllProductData(allProductUrls);
        
        // Step 3: Send data to backend
        if (CONFIG.BACK_END_URL && watchData.length > 0) {
            try {
                console.log(`\n📤 Sending ${watchData.length} watches to backend...`);
                await axios.post(CONFIG.BACK_END_URL, {
                    parentUrl: CONFIG.PARENT_URL,
                    watchData: watchData
                }, {
                    timeout: 30000
                });
                console.log('✅ Watch data posted successfully to backend');
            } catch (error) {
                console.log('⚠️  Could not post to backend (this is OK if backend is not running):', error.message);
            }
        }
        
        return watchData;
    } catch (error) {
        console.error('Error scraping watch data:', error.message);
        return [];
    }
};

// Scheduler function
const startScheduler = async () => {
    const SCRAPE_INTERVAL = CONFIG.CHECK_INTERVAL || 86400000; // Default: 24 hours
    
    console.log('Starting scheduler...');
    console.log(`Scraping interval: ${SCRAPE_INTERVAL / 1000 / 60 / 60} hours`);
    
    // Run initial scrape
    console.log('\nRunning initial scrape...');
    await scrapeWatchData();
    
    // Schedule periodic scrapes
    setInterval(async () => {
        try {
            console.log('\nRunning scheduled scrape...');
            await scrapeWatchData();
        } catch (error) {
            console.error('Error in scheduled scrape:', error.message);
        }
    }, SCRAPE_INTERVAL);
};

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nShutting down...');
    process.exit(0);
});

// Start if running directly
if (require.main === module) {
    console.log('Starting Dubai Chrono Scraper...');
    console.log(`Target URL: ${CONFIG.PARENT_URL}`);
    console.log(`Backend URL: ${CONFIG.BACK_END_URL || 'Not configured'}\n`);
    
    startScheduler().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}

module.exports = { 
    scrapeWatchData,
    getAllProductUrls,
    extractAllProductData,
    extractProductDataFromPage
};


package main

import (
	"bytes"
	"compress/gzip"
	"container/list"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	readability "github.com/go-shiori/go-readability"
)

const (
	hnBaseURL           = "https://hacker-news.firebaseio.com/v0"
	maxStoriesPerFeed   = 120
	defaultStoriesLimit = 30
	maxConcurrentFetch  = 8
	firebaseTimeout     = 5 * time.Second
	listCacheTTL        = 5 * time.Minute
	itemCacheTTL        = 3 * time.Minute
	cacheMaxEntries     = 1200
	cacheJanitorEvery   = 30 * time.Second
	readerTimeout       = 10 * time.Second
	readerMaxHTMLBytes  = 2_000_000
	readerUserAgent     = "hn-cache-aggregator/1.0"
	defaultListenPort   = "8080"
	jsonContentType     = "application/json; charset=utf-8"
	htmlContentType     = "text/html"
	xhtmlContentType    = "application/xhtml+xml"
	gzipEncoding        = "gzip"
	acceptEncoding      = "Accept-Encoding"
	contentEncoding     = "Content-Encoding"
	varyHeader          = "Vary"
	allowHeader         = "Allow"
	accessAllowOrigin   = "Access-Control-Allow-Origin"
	accessAllowMethods  = "Access-Control-Allow-Methods"
	accessAllowHeaders  = "Access-Control-Allow-Headers"
	contentTypeHeader   = "Content-Type"
	noContentStatusCode = http.StatusNoContent
)

type hnItem struct {
	ID          int    `json:"id"`
	Deleted     bool   `json:"deleted,omitempty"`
	Type        string `json:"type"`
	By          string `json:"by,omitempty"`
	Time        int64  `json:"time"`
	Text        string `json:"text,omitempty"`
	Dead        bool   `json:"dead,omitempty"`
	Parent      int    `json:"parent,omitempty"`
	Kids        []int  `json:"kids,omitempty"`
	URL         string `json:"url,omitempty"`
	Score       int    `json:"score,omitempty"`
	Title       string `json:"title,omitempty"`
	Descendants int    `json:"descendants,omitempty"`
}

type storyResponse struct {
	ID          int    `json:"id"`
	Title       string `json:"title,omitempty"`
	URL         string `json:"url,omitempty"`
	Domain      string `json:"domain,omitempty"`
	Score       int    `json:"score"`
	By          string `json:"by,omitempty"`
	Time        int64  `json:"time"`
	Descendants int    `json:"descendants"`
	Kids        []int  `json:"kids"`
	Text        string `json:"text,omitempty"`
	Type        string `json:"type"`
}

type itemResponse struct {
	ID          int    `json:"id"`
	Title       string `json:"title,omitempty"`
	URL         string `json:"url,omitempty"`
	Domain      string `json:"domain,omitempty"`
	Score       int    `json:"score"`
	By          string `json:"by,omitempty"`
	Time        int64  `json:"time"`
	Descendants int    `json:"descendants"`
	Kids        []int  `json:"kids"`
	Text        string `json:"text,omitempty"`
	Type        string `json:"type"`
	Deleted     bool   `json:"deleted"`
	Dead        bool   `json:"dead"`
	Parent      int    `json:"parent,omitempty"`
}

type commentResponse struct {
	ID      int                `json:"id"`
	By      string             `json:"by,omitempty"`
	Time    int64              `json:"time"`
	Text    string             `json:"text,omitempty"`
	Kids    []*commentResponse `json:"kids"`
	Type    string             `json:"type"`
	Deleted bool               `json:"deleted"`
	Dead    bool               `json:"dead"`
}

type threadResponse struct {
	ID          int                `json:"id"`
	Title       string             `json:"title,omitempty"`
	URL         string             `json:"url,omitempty"`
	Domain      string             `json:"domain,omitempty"`
	Score       int                `json:"score"`
	By          string             `json:"by,omitempty"`
	Time        int64              `json:"time"`
	Descendants int                `json:"descendants"`
	Kids        []int              `json:"kids"`
	Text        string             `json:"text,omitempty"`
	Type        string             `json:"type"`
	Comments    []*commentResponse `json:"comments"`
}

type readerResponse struct {
	URL         string `json:"url"`
	FinalURL    string `json:"final_url"`
	Title       string `json:"title,omitempty"`
	Byline      string `json:"byline,omitempty"`
	SiteName    string `json:"site_name,omitempty"`
	Excerpt     string `json:"excerpt,omitempty"`
	Content     string `json:"content,omitempty"`
	TextContent string `json:"text_content,omitempty"`
	Length      int    `json:"length,omitempty"`
}

type server struct {
	client    *http.Client
	cache     *ttlLRUCache
	indexHTML []byte
}

type cacheEntry struct {
	key       string
	value     any
	expiresAt time.Time
	element   *list.Element
}

type ttlLRUCache struct {
	mu         sync.Mutex
	entries    map[string]*cacheEntry
	order      *list.List
	maxEntries int
}

type nilItemMarker struct{}

func newTTLRUCache(maxEntries int) *ttlLRUCache {
	return &ttlLRUCache{
		entries:    make(map[string]*cacheEntry, maxEntries),
		order:      list.New(),
		maxEntries: maxEntries,
	}
}

func (c *ttlLRUCache) Get(key string) (any, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()

	entry, ok := c.entries[key]
	if !ok {
		return nil, false
	}

	now := time.Now()
	if now.After(entry.expiresAt) {
		c.removeEntryLocked(entry)
		return nil, false
	}

	c.order.MoveToFront(entry.element)
	return entry.value, true
}

func (c *ttlLRUCache) Set(key string, value any, ttl time.Duration) {
	if ttl <= 0 {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	if entry, ok := c.entries[key]; ok {
		entry.value = value
		entry.expiresAt = now.Add(ttl)
		c.order.MoveToFront(entry.element)
		c.evictExpiredLocked(now)
		return
	}

	elem := c.order.PushFront(key)
	c.entries[key] = &cacheEntry{
		key:       key,
		value:     value,
		expiresAt: now.Add(ttl),
		element:   elem,
	}

	c.evictExpiredLocked(now)
	c.evictOverflowLocked()
}

func (c *ttlLRUCache) StartJanitor(interval time.Duration) {
	ticker := time.NewTicker(interval)
	go func() {
		for range ticker.C {
			c.mu.Lock()
			c.evictExpiredLocked(time.Now())
			c.mu.Unlock()
		}
	}()
}

func (c *ttlLRUCache) evictExpiredLocked(now time.Time) {
	for _, entry := range c.entries {
		if now.After(entry.expiresAt) {
			c.removeEntryLocked(entry)
		}
	}
}

func (c *ttlLRUCache) evictOverflowLocked() {
	for len(c.entries) > c.maxEntries {
		back := c.order.Back()
		if back == nil {
			return
		}
		key, _ := back.Value.(string)
		entry := c.entries[key]
		if entry == nil {
			c.order.Remove(back)
			continue
		}
		c.removeEntryLocked(entry)
	}
}

func (c *ttlLRUCache) removeEntryLocked(entry *cacheEntry) {
	if entry == nil {
		return
	}
	delete(c.entries, entry.key)
	c.order.Remove(entry.element)
}

func newServer() *server {
	cache := newTTLRUCache(cacheMaxEntries)
	cache.StartJanitor(cacheJanitorEvery)
	indexHTML, err := os.ReadFile("./public/index.html")
	if err != nil {
		log.Printf("index template load failed: %v", err)
	}

	return &server{
		client: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:        100,
				MaxIdleConnsPerHost: 20,
				IdleConnTimeout:     90 * time.Second,
			},
		},
		cache:     cache,
		indexHTML: indexHTML,
	}
}

func main() {
	s := newServer()
	go s.prewarm(context.Background())

	mux := http.NewServeMux()
	mux.HandleFunc("/api/stories", s.handleStories)
	mux.HandleFunc("/api/item", s.handleItem)
	mux.HandleFunc("/api/thread", s.handleThread)
	mux.HandleFunc("/api/reader", s.handleReader)
	mux.Handle("/", s.handleIndex(staticFileHandler(http.Dir("./public"))))

	port := os.Getenv("PORT")
	if port == "" {
		port = defaultListenPort
	}

	httpServer := &http.Server{
		Addr:              ":" + port,
		Handler:           corsMiddleware(gzipMiddleware(mux)),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("HN cache aggregator listening on :%s", port)
	if err := httpServer.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatalf("server failed: %v", err)
	}
}

func (s *server) handleStories(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set(allowHeader, http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	feed := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("feed")))
	if feed == "" {
		writeError(w, http.StatusBadRequest, "missing feed parameter")
		return
	}
	if feed != "best" && feed != "top" && feed != "new" {
		writeError(w, http.StatusBadRequest, "feed must be one of: best, top, new")
		return
	}

	offset := 0
	if rawOffset := strings.TrimSpace(r.URL.Query().Get("offset")); rawOffset != "" {
		parsedOffset, err := strconv.Atoi(rawOffset)
		if err != nil || parsedOffset < 0 {
			writeError(w, http.StatusBadRequest, "offset must be a non-negative integer")
			return
		}
		offset = parsedOffset
	}

	limit := defaultStoriesLimit
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		parsedLimit, err := strconv.Atoi(rawLimit)
		if err != nil || parsedLimit <= 0 {
			writeError(w, http.StatusBadRequest, "limit must be a positive integer")
			return
		}
		if parsedLimit > maxStoriesPerFeed {
			parsedLimit = maxStoriesPerFeed
		}
		limit = parsedLimit
	}

	stories, err := s.getStoriesPage(r.Context(), feed, offset, limit)
	if err != nil {
		log.Printf("story page fetch failed for feed=%s offset=%d limit=%d: %v", feed, offset, limit, err)
		writeError(w, http.StatusBadGateway, "failed to hydrate stories")
		return
	}

	writeJSONCached(w, http.StatusOK, stories, 60*time.Second, 30*time.Second)
}

func (s *server) handleIndex(static http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			static.ServeHTTP(w, r)
			return
		}
		s.serveIndex(w, r)
	})
}

func (s *server) serveIndex(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set(allowHeader, "GET, HEAD")
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	html := s.indexHTML
	if len(html) == 0 {
		staticFileHandler(http.Dir("./public")).ServeHTTP(w, r)
		return
	}

	preloadStories, err := s.getStoriesPage(r.Context(), "best", 0, defaultStoriesLimit)
	if err != nil {
		log.Printf("index preload failed: %v", err)
	}

	payload := map[string]any{
		"feed":    "best",
		"offset":  0,
		"limit":   defaultStoriesLimit,
		"stories": preloadStories,
	}
	preloadJSON, marshalErr := json.Marshal(payload)
	if marshalErr != nil {
		log.Printf("index preload JSON marshal failed: %v", marshalErr)
		preloadJSON = []byte("{}")
	}
	injection := `<script id="hn-preload" type="application/json">` + string(preloadJSON) + `</script>`
	rendered := injectBeforeBodyClose(html, injection)

	w.Header().Set(contentTypeHeader, "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	if _, err := w.Write(rendered); err != nil {
		log.Printf("index write failed: %v", err)
	}
}

func (s *server) getStoriesPage(ctx context.Context, feed string, offset int, limit int) ([]storyResponse, error) {
	ids, err := s.fetchStoryIDs(ctx, feed)
	if err != nil {
		return nil, err
	}

	if len(ids) > maxStoriesPerFeed {
		ids = ids[:maxStoriesPerFeed]
	}
	if offset >= len(ids) {
		return []storyResponse{}, nil
	}

	end := offset + limit
	if end > len(ids) {
		end = len(ids)
	}
	ids = ids[offset:end]

	items, err := s.fetchItemsConcurrently(ctx, ids)
	if err != nil {
		return nil, err
	}

	stories := make([]storyResponse, 0, len(items))
	for _, item := range items {
		if item == nil {
			continue
		}
		stories = append(stories, toStoryResponse(item))
	}
	return stories, nil
}

func (s *server) handleItem(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set(allowHeader, http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	id, ok := parseID(r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id parameter")
		return
	}

	item, err := s.fetchItem(r.Context(), id)
	if err != nil {
		log.Printf("item fetch failed id=%d: %v", id, err)
		writeError(w, http.StatusBadGateway, "failed to fetch item")
		return
	}
	if item == nil {
		writeError(w, http.StatusNotFound, "item not found")
		return
	}

	writeJSONCached(w, http.StatusOK, toItemResponse(item), 120*time.Second, 60*time.Second)
}

func (s *server) handleThread(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set(allowHeader, http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	id, ok := parseID(r.URL.Query().Get("id"))
	if !ok {
		writeError(w, http.StatusBadRequest, "invalid id parameter")
		return
	}

	story, err := s.fetchItem(r.Context(), id)
	if err != nil {
		log.Printf("thread story fetch failed id=%d: %v", id, err)
		writeError(w, http.StatusBadGateway, "failed to fetch story")
		return
	}
	if story == nil {
		writeError(w, http.StatusNotFound, "story not found")
		return
	}
	if story.Type != "story" {
		writeError(w, http.StatusBadRequest, "id must reference a story item")
		return
	}

	comments, err := s.fetchCommentForest(r.Context(), story.Kids)
	if err != nil {
		log.Printf("thread comment hydration failed id=%d: %v", id, err)
		writeError(w, http.StatusBadGateway, "failed to hydrate comment tree")
		return
	}

	writeJSONCached(w, http.StatusOK, toThreadResponse(story, comments), 120*time.Second, 60*time.Second)
}

func (s *server) handleReader(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set(allowHeader, http.MethodGet)
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	rawURL := strings.TrimSpace(r.URL.Query().Get("url"))
	if rawURL == "" {
		writeError(w, http.StatusBadRequest, "missing url parameter")
		return
	}

	parsedURL, err := url.ParseRequestURI(rawURL)
	if err != nil || parsedURL.Host == "" {
		writeError(w, http.StatusBadRequest, "invalid url parameter")
		return
	}
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		writeError(w, http.StatusBadRequest, "url must use http or https")
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), readerTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, parsedURL.String(), nil)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid request URL")
		return
	}
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	req.Header.Set("User-Agent", readerUserAgent)

	resp, err := s.client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			writeError(w, http.StatusGatewayTimeout, "reader request timed out")
			return
		}
		log.Printf("reader request failed url=%s: %v", parsedURL.String(), err)
		writeError(w, http.StatusBadGateway, "failed to fetch article")
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < http.StatusOK || resp.StatusCode > 299 {
		writeError(w, http.StatusBadGateway, fmt.Sprintf("upstream request failed (%d)", resp.StatusCode))
		return
	}

	contentType := strings.ToLower(resp.Header.Get(contentTypeHeader))
	if !strings.Contains(contentType, htmlContentType) && !strings.Contains(contentType, xhtmlContentType) {
		writeError(w, http.StatusUnsupportedMediaType, "URL did not return HTML")
		return
	}

	finalURL := parsedURL
	if resp.Request != nil && resp.Request.URL != nil {
		finalURL = resp.Request.URL
	}

	limited := io.LimitReader(resp.Body, readerMaxHTMLBytes)
	article, err := readability.FromReader(limited, finalURL)
	if err != nil {
		log.Printf("readability parse failed url=%s: %v", parsedURL.String(), err)
		writeError(w, http.StatusBadGateway, "failed to extract article")
		return
	}

	if strings.TrimSpace(article.Content) == "" && strings.TrimSpace(article.TextContent) == "" {
		writeError(w, http.StatusBadGateway, "article content was empty")
		return
	}

	writeJSON(w, http.StatusOK, readerResponse{
		URL:         parsedURL.String(),
		FinalURL:    finalURL.String(),
		Title:       article.Title,
		Byline:      article.Byline,
		SiteName:    article.SiteName,
		Excerpt:     article.Excerpt,
		Content:     article.Content,
		TextContent: article.TextContent,
		Length:      article.Length,
	})
}

func (s *server) fetchStoryIDs(ctx context.Context, feed string) ([]int, error) {
	path := ""
	switch feed {
	case "best":
		path = "beststories.json"
	case "top":
		path = "topstories.json"
	case "new":
		path = "newstories.json"
	default:
		return nil, fmt.Errorf("invalid feed: %s", feed)
	}

	cacheKey := "list:" + feed
	if cached, ok := s.cache.Get(cacheKey); ok {
		if ids, ok := cached.([]int); ok {
			return append([]int(nil), ids...), nil
		}
	}

	var ids []int
	if err := s.fetchFirebaseJSON(ctx, path, &ids); err != nil {
		return nil, err
	}
	if ids == nil {
		ids = []int{}
	}

	s.cache.Set(cacheKey, append([]int(nil), ids...), listCacheTTL)
	return ids, nil
}

func (s *server) fetchItem(ctx context.Context, id int) (*hnItem, error) {
	if id <= 0 {
		return nil, fmt.Errorf("invalid item id: %d", id)
	}

	cacheKey := fmt.Sprintf("item:%d", id)
	if cached, ok := s.cache.Get(cacheKey); ok {
		switch v := cached.(type) {
		case *hnItem:
			return cloneItem(v), nil
		case nilItemMarker:
			return nil, nil
		}
	}

	var raw json.RawMessage
	itemPath := fmt.Sprintf("item/%d.json", id)
	if err := s.fetchFirebaseJSON(ctx, itemPath, &raw); err != nil {
		return nil, err
	}

	if len(bytes.TrimSpace(raw)) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		s.cache.Set(cacheKey, nilItemMarker{}, itemCacheTTL)
		return nil, nil
	}

	var item hnItem
	if err := json.Unmarshal(raw, &item); err != nil {
		return nil, err
	}

	s.cache.Set(cacheKey, cloneItem(&item), itemCacheTTL)
	return &item, nil
}

func (s *server) fetchItemsConcurrently(ctx context.Context, ids []int) ([]*hnItem, error) {
	results := make([]*hnItem, len(ids))
	sem := make(chan struct{}, maxConcurrentFetch)
	errCh := make(chan error, 1)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	setErr := func(err error) {
		select {
		case errCh <- err:
			cancel()
		default:
		}
	}

	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(idx, itemID int) {
			defer wg.Done()

			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-sem }()

			item, err := s.fetchItem(ctx, itemID)
			if err != nil {
				setErr(err)
				return
			}
			results[idx] = item
		}(i, id)
	}

	wg.Wait()
	select {
	case err := <-errCh:
		return nil, err
	default:
		return results, nil
	}
}

func (s *server) fetchCommentForest(ctx context.Context, ids []int) ([]*commentResponse, error) {
	if len(ids) == 0 {
		return []*commentResponse{}, nil
	}

	results := make([]*commentResponse, len(ids))
	sem := make(chan struct{}, maxConcurrentFetch)
	errCh := make(chan error, 1)

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	setErr := func(err error) {
		select {
		case errCh <- err:
			cancel()
		default:
		}
	}

	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(idx, commentID int) {
			defer wg.Done()
			node, err := s.fetchCommentNode(ctx, commentID, sem)
			if err != nil {
				setErr(err)
				return
			}
			results[idx] = node
		}(i, id)
	}

	wg.Wait()
	select {
	case err := <-errCh:
		return nil, err
	default:
		return compactComments(results), nil
	}
}

func (s *server) fetchCommentNode(ctx context.Context, id int, sem chan struct{}) (*commentResponse, error) {
	select {
	case sem <- struct{}{}:
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	item, err := s.fetchItem(ctx, id)
	<-sem
	if err != nil {
		return nil, err
	}
	if item == nil || item.Type != "comment" {
		return nil, nil
	}

	node := toCommentResponse(item)
	if len(item.Kids) == 0 {
		return node, nil
	}

	children := make([]*commentResponse, len(item.Kids))
	errCh := make(chan error, 1)
	var once sync.Once
	var wg sync.WaitGroup
	for i, childID := range item.Kids {
		wg.Add(1)
		go func(idx, cid int) {
			defer wg.Done()
			child, childErr := s.fetchCommentNode(ctx, cid, sem)
			if childErr != nil {
				once.Do(func() {
					errCh <- childErr
				})
				return
			}
			children[idx] = child
		}(i, childID)
	}
	wg.Wait()

	select {
	case childErr := <-errCh:
		return nil, childErr
	default:
		node.Kids = compactComments(children)
		return node, nil
	}
}

func (s *server) fetchFirebaseJSON(ctx context.Context, path string, dst any) error {
	ctx, cancel := context.WithTimeout(ctx, firebaseTimeout)
	defer cancel()

	endpoint := strings.TrimRight(hnBaseURL, "/") + "/" + strings.TrimLeft(path, "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", readerUserAgent)

	resp, err := s.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("firebase returned status %d", resp.StatusCode)
	}

	decoder := json.NewDecoder(io.LimitReader(resp.Body, 4_000_000))
	return decoder.Decode(dst)
}

func (s *server) prewarm(ctx context.Context) {
	feeds := []string{"best", "top", "new"}
	for _, feed := range feeds {
		feed := feed
		go func() {
			warmCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			defer cancel()

			stories, err := s.getStoriesPage(warmCtx, feed, 0, defaultStoriesLimit)
			if err != nil {
				log.Printf("cache prewarm failed for feed=%s: %v", feed, err)
				return
			}
			log.Printf("cache prewarm complete for feed=%s count=%d", feed, len(stories))
		}()
	}
}

func parseID(raw string) (int, bool) {
	id, err := strconv.Atoi(strings.TrimSpace(raw))
	if err != nil || id <= 0 {
		return 0, false
	}
	return id, true
}

func toStoryResponse(item *hnItem) storyResponse {
	kids := append([]int(nil), item.Kids...)
	if kids == nil {
		kids = []int{}
	}
	return storyResponse{
		ID:          item.ID,
		Title:       item.Title,
		URL:         item.URL,
		Domain:      extractDomain(item.URL),
		Score:       item.Score,
		By:          item.By,
		Time:        item.Time,
		Descendants: item.Descendants,
		Kids:        kids,
		Text:        item.Text,
		Type:        item.Type,
	}
}

func toItemResponse(item *hnItem) itemResponse {
	kids := append([]int(nil), item.Kids...)
	if kids == nil {
		kids = []int{}
	}
	return itemResponse{
		ID:          item.ID,
		Title:       item.Title,
		URL:         item.URL,
		Domain:      extractDomain(item.URL),
		Score:       item.Score,
		By:          item.By,
		Time:        item.Time,
		Descendants: item.Descendants,
		Kids:        kids,
		Text:        item.Text,
		Type:        item.Type,
		Deleted:     item.Deleted,
		Dead:        item.Dead,
		Parent:      item.Parent,
	}
}

func toCommentResponse(item *hnItem) *commentResponse {
	return &commentResponse{
		ID:      item.ID,
		By:      item.By,
		Time:    item.Time,
		Text:    item.Text,
		Kids:    []*commentResponse{},
		Type:    item.Type,
		Deleted: item.Deleted,
		Dead:    item.Dead,
	}
}

func toThreadResponse(story *hnItem, comments []*commentResponse) threadResponse {
	storyPayload := toStoryResponse(story)
	if comments == nil {
		comments = []*commentResponse{}
	}
	return threadResponse{
		ID:          storyPayload.ID,
		Title:       storyPayload.Title,
		URL:         storyPayload.URL,
		Domain:      storyPayload.Domain,
		Score:       storyPayload.Score,
		By:          storyPayload.By,
		Time:        storyPayload.Time,
		Descendants: storyPayload.Descendants,
		Kids:        storyPayload.Kids,
		Text:        storyPayload.Text,
		Type:        storyPayload.Type,
		Comments:    comments,
	}
}

func extractDomain(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Hostname() == "" {
		return ""
	}
	host := strings.ToLower(parsed.Hostname())
	return strings.TrimPrefix(host, "www.")
}

func cloneItem(item *hnItem) *hnItem {
	if item == nil {
		return nil
	}
	copied := *item
	copied.Kids = append([]int(nil), item.Kids...)
	return &copied
}

func compactComments(nodes []*commentResponse) []*commentResponse {
	compacted := make([]*commentResponse, 0, len(nodes))
	for _, node := range nodes {
		if node != nil {
			compacted = append(compacted, node)
		}
	}
	if compacted == nil {
		return []*commentResponse{}
	}
	return compacted
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set(contentTypeHeader, jsonContentType)
	w.WriteHeader(status)
	encoder := json.NewEncoder(w)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(payload); err != nil {
		log.Printf("response encode failed: %v", err)
	}
}

func writeJSONCached(w http.ResponseWriter, status int, payload any, maxAge time.Duration, swr time.Duration) {
	if maxAge > 0 {
		cc := fmt.Sprintf("public, max-age=%d", int(maxAge.Seconds()))
		if swr > 0 {
			cc += fmt.Sprintf(", stale-while-revalidate=%d", int(swr.Seconds()))
		}
		w.Header().Set("Cache-Control", cc)
	}
	writeJSON(w, status, payload)
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set(accessAllowOrigin, "*")
		w.Header().Set(accessAllowMethods, "GET, OPTIONS")
		w.Header().Set(accessAllowHeaders, "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(noContentStatusCode)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type gzipResponseWriter struct {
	http.ResponseWriter
	writer      *gzip.Writer
	wroteHeader bool
}

func (g *gzipResponseWriter) WriteHeader(statusCode int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	g.Header().Del("Content-Length")
	g.Header().Set(contentEncoding, gzipEncoding)
	g.Header().Add(varyHeader, acceptEncoding)
	g.ResponseWriter.WriteHeader(statusCode)
}

func (g *gzipResponseWriter) Write(data []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.Header().Get(contentTypeHeader) == "" {
		g.Header().Set(contentTypeHeader, http.DetectContentType(data))
	}
	return g.writer.Write(data)
}

func (g *gzipResponseWriter) Flush() {
	_ = g.writer.Flush()
	if flusher, ok := g.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

var gzipWriterPool = sync.Pool{
	New: func() any {
		w, _ := gzip.NewWriterLevel(io.Discard, gzip.BestSpeed)
		return w
	},
}

func gzipMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get(acceptEncoding), gzipEncoding) {
			next.ServeHTTP(w, r)
			return
		}
		if strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") {
			next.ServeHTTP(w, r)
			return
		}

		gz := gzipWriterPool.Get().(*gzip.Writer)
		gz.Reset(w)
		defer func() {
			_ = gz.Close()
			gzipWriterPool.Put(gz)
		}()

		next.ServeHTTP(&gzipResponseWriter{
			ResponseWriter: w,
			writer:         gz,
		}, r)
	})
}

func staticFileHandler(root http.FileSystem) http.Handler {
	fs := http.FileServer(root)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		switch {
		case strings.HasSuffix(path, ".html"), path == "/", path == "/sw.js":
			w.Header().Set("Cache-Control", "no-cache")
		case path == "/app.js", path == "/styles.css":
			w.Header().Set("Cache-Control", "public, max-age=300, must-revalidate")
		default:
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		}
		fs.ServeHTTP(w, r)
	})
}

func injectBeforeBodyClose(document []byte, injection string) []byte {
	if len(document) == 0 || injection == "" {
		return document
	}

	lower := bytes.ToLower(document)
	closeTag := []byte("</body>")
	idx := bytes.LastIndex(lower, closeTag)
	if idx < 0 {
		rendered := make([]byte, 0, len(document)+len(injection))
		rendered = append(rendered, document...)
		rendered = append(rendered, injection...)
		return rendered
	}

	rendered := make([]byte, 0, len(document)+len(injection))
	rendered = append(rendered, document[:idx]...)
	rendered = append(rendered, injection...)
	rendered = append(rendered, document[idx:]...)
	return rendered
}

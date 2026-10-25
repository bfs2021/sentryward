package api

import (
	"net/http"
	"strconv"

	"example.com/shop/paging"
)

const pageSize = 50

// GET /orders?page=N, where page 1 is the first (the documented API).
func listOrders(w http.ResponseWriter, r *http.Request) {
	page, err := strconv.Atoi(r.URL.Query().Get("page"))
	if err != nil {
		page = 1
	}
	rows := queryOrders(paging.Offset(page, pageSize), pageSize)
	writeJSON(w, rows)
}

package paging

// Offset is the first row of a page.
func Offset(page, size int) int {
	if page < 0 {
		page = 0
	}
	return page * size
}

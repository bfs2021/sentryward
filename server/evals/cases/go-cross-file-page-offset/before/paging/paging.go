package paging

// Offset is the first row of a page. Pages are numbered from 1.
func Offset(page, size int) int {
	if page < 1 {
		page = 1
	}
	return (page - 1) * size
}

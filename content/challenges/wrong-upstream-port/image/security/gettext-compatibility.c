/* Normal catalog lookup and benign path rejection in the isolated build stage. */
#include <libintl.h>
#include <locale.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static void check(const char *directory, const char *language, const char *expected)
{
    if (bindtextdomain("ordinary", directory) == NULL || setenv("LANGUAGE", language, 1) != 0)
        exit(1);
    if (strcmp(gettext("cheese"), expected) != 0) {
        fprintf(stderr, "Unexpected catalog lookup result\n");
        exit(1);
    }
}

int main(int argc, char **argv)
{
    if (argc != 4 || setlocale(LC_ALL, "de_DE.UTF-8") == NULL || textdomain("ordinary") == NULL)
        return 1;
    check(argv[1], "de_DE", "Kaese");
    check(argv[3], "..", "cheese");
    check(argv[2], "../de_DE", "cheese");
    check(argv[1], "..:../de_DE:de_DE", "Kaese");
    check(argv[3], "../../de_DE", "cheese");
    return 0;
}

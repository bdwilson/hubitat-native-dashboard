/*
 * Parse-check a Hubitat App/Driver source file without a hub.
 *
 *   groovy build/check-groovy.groovy app/HubitatNativeDashboard.groovy
 *
 * Compiles the file all the way to CLASS_GENERATION. That phase is what catches
 * the class of error this repo actually shipped once — "Modifier 'private' not
 * allowed here" — which earlier phases (CONVERSION, SEMANTIC_ANALYSIS) let
 * through; it was verified here that only CLASS_GENERATION rejects it.
 *
 * Compiling this far works without a hub because every Hubitat DSL call
 * (definition/preferences/mappings/httpGet/render/...) is a dynamic method call
 * on the script, which Groovy does not resolve at compile time. Only real types
 * have to exist, and this file uses none beyond the JDK and groovy.json.
 *
 * What it does NOT do: prove the app works. It cannot see whether a Hubitat API
 * is used correctly, whether a route returns what the UI expects, or anything
 * about runtime behaviour on a real hub. Treat a pass as "the hub will accept
 * this file", not "this file is correct".
 *
 * Install Groovy 2.4.x (matching Hubitat's) with:  apt-get install -y groovy
 */

import org.codehaus.groovy.control.CompilationUnit
import org.codehaus.groovy.control.CompilerConfiguration
import org.codehaus.groovy.control.Phases
import org.codehaus.groovy.control.MultipleCompilationErrorsException

if (args.length < 1) {
    System.err.println "usage: groovy build/check-groovy.groovy <file.groovy> [more.groovy ...]"
    System.exit 2
}

int failures = 0

args.each { String path ->
    File f = new File(path)
    if (!f.exists()) {
        System.err.println "MISSING  ${path}"
        failures++
        return
    }

    def cu = new CompilationUnit(new CompilerConfiguration())
    cu.addSource(f)
    try {
        cu.compile(Phases.CLASS_GENERATION)
        println "OK       ${path}  (${f.length()} bytes, ${f.readLines().size()} lines)"
    } catch (MultipleCompilationErrorsException e) {
        System.err.println "FAILED   ${path}"
        e.errorCollector.errors.each { err ->
            // SyntaxErrorMessage's own toString() is just its object identity,
            // so unwrap the SyntaxException to report line/column and text —
            // the same detail the Hubitat editor shows when it rejects a save.
            def se = err.hasProperty('cause') ? err.cause : null
            if (se != null) {
                System.err.println "         line ${se.line}, column ${se.startColumn}: ${se.originalMessage}"
            } else {
                System.err.println "         ${err}"
            }
        }
        failures++
    } catch (Throwable t) {
        System.err.println "FAILED   ${path}: ${t.class.simpleName}: ${t.message}"
        failures++
    }
}

System.exit(failures == 0 ? 0 : 1)

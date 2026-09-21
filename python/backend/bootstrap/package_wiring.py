from __future__ import annotations

from backend.bootstrap.container import PackageCases
from backend.bootstrap.wiring import ProcessingWiring, ProjectWiring, RuntimeWiring
from backend.infrastructure.local_storage import LocalPackageOutputStorage
from backend.infrastructure.zip_archive import ZipPackageArchive
from backend.packages.background import StartPackageExport, StartPackageImport
from backend.packages.export_package import ExportPackage
from backend.packages.import_package import ImportPackage
from backend.packages.inspect_package import InspectPackage
from backend.packages.preflight import PackageExportPreflight, PackageImportPreflight
from backend.packages.project_publication import PackageProjectPublication
from backend.packages.security import PackageSecurityValidator


def build_package_cases(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
) -> PackageCases:
    archive = ZipPackageArchive()
    inspect = InspectPackage(
        runtime.database,
        archive,
        PackageSecurityValidator(runtime.config.packages),
    )
    export = _package_export(runtime, project, processing, archive)
    publication = PackageProjectPublication(
        archive,
        project.projects,
        project.validator,
        processing.workspaces,
        project.journal,
        runtime.hasher,
    )
    importer = ImportPackage(
        runtime.database,
        inspect,
        publication,
        project.operations,
        runtime.clock,
        runtime.ids,
    )
    return PackageCases(
        inspect,
        _start_export(runtime, project, processing, export),
        _start_import(runtime, processing, inspect, importer),
    )


def _package_export(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    archive: ZipPackageArchive,
) -> ExportPackage:
    return ExportPackage(
        runtime.database,
        project.projects,
        archive,
        LocalPackageOutputStorage(runtime.config.roots.app / "exports"),
        processing.workspaces,
        project.operations,
        runtime.hasher,
        runtime.clock,
        runtime.ids,
    )


def _start_export(
    runtime: RuntimeWiring,
    project: ProjectWiring,
    processing: ProcessingWiring,
    export: ExportPackage,
) -> StartPackageExport:
    preflight = PackageExportPreflight(
        runtime.database,
        project.projects,
        processing.storage,
        runtime.config.roots.temp,
        runtime.config.resources.min_free_disk_bytes,
    )
    return StartPackageExport(processing.jobs, export, preflight)


def _start_import(
    runtime: RuntimeWiring,
    processing: ProcessingWiring,
    inspect: InspectPackage,
    importer: ImportPackage,
) -> StartPackageImport:
    preflight = PackageImportPreflight(
        inspect,
        processing.storage,
        runtime.config.roots.temp,
        runtime.config.resources.min_free_disk_bytes,
    )
    return StartPackageImport(
        runtime.database,
        processing.jobs,
        importer,
        runtime.hasher,
        runtime.clock,
        preflight,
    )

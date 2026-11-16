if(NOT BUILD_DIR OR NOT CONFIG OR NOT AUDIO_FILENAME OR NOT RELAY_FILENAME)
    message(FATAL_ERROR "Runtime install verification requires BUILD_DIR, CONFIG, AUDIO_FILENAME, and RELAY_FILENAME")
endif()

set(temporary_root "${BUILD_DIR}")
if(DEFINED ENV{TEMP})
    file(TO_CMAKE_PATH "$ENV{TEMP}" temporary_root)
endif()
set(destination "${temporary_root}/runtime-install-verification/${CONFIG}")
execute_process(
    COMMAND "${CMAKE_COMMAND}" --install "${BUILD_DIR}" --config "${CONFIG}"
            --component AudioServiceRuntime --prefix "${destination}"
    RESULT_VARIABLE install_result
    OUTPUT_VARIABLE install_output
    ERROR_VARIABLE install_error
)
if(NOT install_result EQUAL 0)
    message(FATAL_ERROR "Runtime install failed: ${install_output}${install_error}")
endif()
foreach(binary "${AUDIO_FILENAME}" "${RELAY_FILENAME}")
    if(NOT EXISTS "${destination}/${binary}")
        message(FATAL_ERROR "Runtime install omitted ${binary}: ${install_output}")
    endif()
endforeach()
